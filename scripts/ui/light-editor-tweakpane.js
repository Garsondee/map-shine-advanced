/**
 * @fileoverview LightEditorTweakpane
 * Unified Tweakpane-based light editor combining core Foundry fields with MapShine enhancements.
 * Replaces the details panel approach with a modern, consistent UI.
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';

const log = createLogger('LightEditorTweakpane');

const DEFAULT_COOKIE_TEXTURE = 'modules/map-shine-advanced/assets/kenney assets/light_01.png';

const UI_POS_FLAG_SCOPE = 'map-shine-advanced';
const UI_POS_FLAG_KEY = 'lightEditorScreenPositions';

function _toCssColor(value, fallback = '#ffffff') {
  try {
    if (value == null) return fallback;

    // Foundry v12+ uses a Color object (common/utils/color.mjs)
    // which provides a .css getter and toString() -> "#RRGGBB".
    if (typeof value === 'object') {
      const css = value?.css;
      if (typeof css === 'string' && css) return css;
      const s = value?.toString?.();
      if (typeof s === 'string' && s) return s;
    }

    // CSS hex string
    if (typeof value === 'string') return value || fallback;

    // Numeric hex
    if (typeof value === 'number' && Number.isFinite(value)) {
      const hex = Math.max(0, Math.min(0xFFFFFF, Math.floor(value)));
      return `#${hex.toString(16).padStart(6, '0')}`;
    }
  } catch (_) {
  }
  return fallback;
}

function _isObject(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function _clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function _asFiniteNumber(x, fallback) {
  const n = (typeof x === 'number') ? x : Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function _stopAndPrevent(e) {
  try { e.preventDefault(); } catch (_) {}
  try { e.stopPropagation(); } catch (_) {}
  try { e.stopImmediatePropagation?.(); } catch (_) {}
}

function _stopAndPreventDrag(e) {
  // IMPORTANT: during window-level drag tracking, do NOT call stopImmediatePropagation.
  // Foundry (and other modules) may rely on global pointer handlers.
  try { e.preventDefault(); } catch (_) {}
  try { e.stopPropagation(); } catch (_) {}
}

function _stopPropagationOnly(e) {
  try { e.stopPropagation(); } catch (_) {}
  try { e.stopImmediatePropagation?.(); } catch (_) {}
}

function _buildAnimationOptions(isDarkness, currentValue) {
  const options = [{ value: '', label: 'None' }];
  const config = globalThis.CONFIG?.Canvas;
  const animations = isDarkness ? config?.darknessAnimations : config?.lightAnimations;

  if (animations && typeof animations === 'object') {
    for (const [key, cfg] of Object.entries(animations)) {
      const labelKey = cfg?.label;
      const label = (labelKey && globalThis.game?.i18n?.localize)
        ? game.i18n.localize(labelKey)
        : (labelKey || key);
      options.push({ value: key, label });
    }
  }

  if (!options.some((opt) => opt.value === 'cableswing')) {
    options.push({ value: 'cableswing', label: 'Cable Swing (MapShine)' });
  }

  if (currentValue && !options.some((opt) => opt.value === currentValue)) {
    options.push({ value: currentValue, label: currentValue });
  }

  return options;
}

function _optionsToMap(options) {
  const out = {};
  for (const opt of options) {
    out[opt.label] = opt.value;
  }
  return out;
}

/**
 * Unified Light Editor using Tweakpane
 */
export class LightEditorTweakpane {
  /**
   * @param {import('./overlay-ui-manager.js').OverlayUIManager} overlayManager
   */
  constructor(overlayManager) {
    this.overlayManager = overlayManager;

    /** @type {{type:'foundry'|'enhanced', id:string}|null} */
    this.current = null;

    /** @type {THREE.Object3D|null} */
    this._anchorObject = null;

    /** @type {HTMLElement|null} */
    this.container = null;

    /** @type {HTMLElement|null} */
    this._panel = null;

    /** @type {import('./overlay-ui-manager.js').OverlayHandle|null} */
    this._overlayHandle = null;

    /** @type {HTMLElement|null} */
    this._paneContainer = null;

    /** @type {Tweakpane.Pane|null} */
    this._pane = null;

    /** @type {Object} */
    this._params = {
      // Core
      enabled: true,
      negative: false,
      color: '#ffffff',
      priority: 0,
      angle: 360,
      dim: 30,
      bright: 15,
      alpha: 0.5,
      attenuation: 0.5,
      luminosity: 0.5,
      coloration: 1,
      saturation: 0,
      contrast: 0,
      shadows: 0,
      darknessMin: 0.0,
      darknessMax: 1.0,
      // Animation
      animType: '',
      animSpeed: 5,
      animIntensity: 5,
      animReverse: false,
      // Cookie
      cookieEnabled: false,
      cookieTexture: DEFAULT_COOKIE_TEXTURE,
      cookieStrength: 1.0,
      cookieContrast: 1.0,
      cookieGamma: 1.0,
      cookieInvert: false,
      cookieColorize: false,
      cookieTint: '#ffffff',
      // Output shaping
      outputGain: 1.0,
      outerWeight: 0.5,
      innerWeight: 0.5,
      // Target layers
      targetLayers: 'both',
      // Sun (darkness response)
      sunEnabled: false,
      sunInvert: true,
      sunExponent: 1.0,
      sunMin: 0.0,
      sunMax: 1.0
    };

    /** @type {Map<string, any>} */
    this._bindings = new Map();

    this._paneOptionsKey = '';
    this._tmpAnchorWorld = null;
    this._panelWidth = 340;
    this._suppressInput = false;

    // While we are applying user edits (doc.update or scene flag writes), we suppress
    // hook-driven refreshes to avoid the UI snapping back to the previous state.
    // Once the write completes, we schedule a refresh to re-read authoritative state.
    this._applyInFlight = 0;
    this._pendingRefresh = false;

    this._refreshDebounceMs = 50;
    this._refreshTimeout = null;
    this._hooksRegistered = false;

    this._drag = {
      active: false,
      startClientX: 0,
      startClientY: 0,
      startLeft: 0,
      startTop: 0,
    };

    this._boundDragHandlers = {
      onMove: (e) => this._onHeaderDragMove(e),
      onUp: (e) => this._onHeaderDragUp(e),
    };
  }

  _scheduleRefresh() {
    try {
      if (!this.current) return;
      if (this._suppressInput) return;
      if (this._applyInFlight > 0) {
        this._pendingRefresh = true;
        return;
      }

      if (this._refreshTimeout) {
        clearTimeout(this._refreshTimeout);
        this._refreshTimeout = null;
      }

      this._refreshTimeout = setTimeout(() => {
        this._refreshTimeout = null;
        this._refreshFromSource();
      }, this._refreshDebounceMs);
    } catch (_) {
    }
  }

  _registerHooks() {
    if (this._hooksRegistered) return;

    try {
      // Keep UI consistent if light is edited by Foundry sheet or another client.
      Hooks.on('updateAmbientLight', (doc) => {
        if (!this.current) return;
        if (this.current.type !== 'foundry') return;
        if (String(doc?.id) !== String(this.current.id)) return;
        this._scheduleRefresh();
      });

      // Enhancement data is stored in scene flags; ensure we refresh when flags change.
      Hooks.on('updateScene', (_scene, changes) => {
        if (!this.current) return;

        const flags = changes?.flags?.[UI_POS_FLAG_SCOPE];
        if (!flags || typeof flags !== 'object') return;

        // lightEnhancements drives cookie/output/sun for Foundry lights.
        if (flags.lightEnhancements !== undefined && this.current.type === 'foundry') {
          this._scheduleRefresh();
          return;
        }

        // enhancedLights drives MapShine-native enhanced lights.
        if (flags.enhancedLights !== undefined && this.current.type === 'enhanced') {
          this._scheduleRefresh();
        }
      });
    } catch (_) {
    }

    this._hooksRegistered = true;
  }

  _beginHeaderDrag(e) {
    try {
      // Do not start a drag on the close button.
      const t = e.target;
      if (t instanceof Element && t.closest('button')) return;
    } catch (_) {}

    _stopAndPreventDrag(e);

    if (!this._overlayHandle) return;
    if (!this.current) return;

    // Start from current onscreen position.
    // NOTE: style.left/top may still be "0px" if we haven't rendered a frame yet.
    // Using the panel's actual bounding rect is more robust.
    let startX = NaN;
    let startY = NaN;
    try {
      const rect = this._panel?.getBoundingClientRect?.();
      if (rect && rect.width && rect.height) {
        startX = rect.left + rect.width * 0.5;
        startY = rect.top + rect.height * 0.5;
      }
    } catch (_) {}

    if (!Number.isFinite(startX) || !Number.isFinite(startY)) {
      const left = parseFloat(this._overlayHandle.el?.style?.left || '0');
      const top = parseFloat(this._overlayHandle.el?.style?.top || '0');
      startX = Number.isFinite(left) ? left : 0;
      startY = Number.isFinite(top) ? top : 0;
    }

    this._drag.active = true;
    this._drag.startClientX = e.clientX;
    this._drag.startClientY = e.clientY;
    this._drag.startLeft = startX;
    this._drag.startTop = startY;

    // Once the user drags, this UI is no longer anchored to the light.
    this.overlayManager.lockOverlay('light-editor', { x: this._drag.startLeft, y: this._drag.startTop });

    // Apply immediately so the first drag frame moves even if OverlayUIManager.update() hasn't run yet.
    try {
      this._overlayHandle.el.style.left = `${Math.round(this._drag.startLeft)}px`;
      this._overlayHandle.el.style.top = `${Math.round(this._drag.startTop)}px`;
    } catch (_) {}

    try { this._overlayHandle.el?.setPointerCapture?.(e.pointerId); } catch (_) {}

    // Listen globally so we don't miss pointerup if the cursor leaves the header.
    try {
      window.addEventListener('pointermove', this._boundDragHandlers.onMove, true);
      window.addEventListener('pointerup', this._boundDragHandlers.onUp, true);
      window.addEventListener('pointercancel', this._boundDragHandlers.onUp, true);
    } catch (_) {}
  }

  _endHeaderDragListeners() {
    try {
      window.removeEventListener('pointermove', this._boundDragHandlers.onMove, true);
      window.removeEventListener('pointerup', this._boundDragHandlers.onUp, true);
      window.removeEventListener('pointercancel', this._boundDragHandlers.onUp, true);
    } catch (_) {}
  }

  _onHeaderDragMove(e) {
    try {
      if (!this._drag.active) return;
      _stopAndPreventDrag(e);

      if (!this._overlayHandle) return;
      if (!this.current) return;

      const dx = e.clientX - this._drag.startClientX;
      const dy = e.clientY - this._drag.startClientY;
      const x = this._drag.startLeft + dx;
      const y = this._drag.startTop + dy;
      this.overlayManager.lockOverlay('light-editor', { x, y });

      // Apply immediately so it feels responsive even if overlay updates are throttled.
      try {
        this._overlayHandle.el.style.left = `${Math.round(x)}px`;
        this._overlayHandle.el.style.top = `${Math.round(y)}px`;
      } catch (_) {}
    } catch (_) {
      // If anything goes wrong during global drag tracking, fail safe.
      this._drag.active = false;
      this._endHeaderDragListeners();
    }
  }

  async _onHeaderDragUp(e) {
    try {
      if (!this._drag.active) return;
      _stopAndPreventDrag(e);
      this._drag.active = false;

      this._endHeaderDragListeners();

      if (!this._overlayHandle) return;
      if (!this.current) return;

      const left = parseFloat(this._overlayHandle.el?.style?.left || '0');
      const top = parseFloat(this._overlayHandle.el?.style?.top || '0');
      const screenPos = { x: Number.isFinite(left) ? left : 0, y: Number.isFinite(top) ? top : 0 };

      await this._setPersistedScreenPos(this.current.id, screenPos);
    } catch (_) {
      this._drag.active = false;
      this._endHeaderDragListeners();
    }
  }

  _getPersistedScreenPos(lightId) {
    try {
      const scene = globalThis.canvas?.scene;
      if (!scene || !lightId) return null;
      const all = scene.getFlag(UI_POS_FLAG_SCOPE, UI_POS_FLAG_KEY);
      if (!all || typeof all !== 'object') return null;
      const pos = all[String(lightId)];
      if (!pos || typeof pos !== 'object') return null;
      const x = pos.x;
      const y = pos.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    } catch (_) {
      return null;
    }
  }

  async _setPersistedScreenPos(lightId, screenPos) {
    try {
      const scene = globalThis.canvas?.scene;
      if (!scene || !lightId) return;
      if (!screenPos || !Number.isFinite(screenPos.x) || !Number.isFinite(screenPos.y)) return;

      const all = scene.getFlag(UI_POS_FLAG_SCOPE, UI_POS_FLAG_KEY);
      const next = (all && typeof all === 'object') ? { ...all } : {};
      next[String(lightId)] = { x: screenPos.x, y: screenPos.y };

      await scene.setFlag(UI_POS_FLAG_SCOPE, UI_POS_FLAG_KEY, next);
    } catch (_) {
    }
  }

  initialize() {
    if (this.container) return;

    const h = this.overlayManager.createOverlay('light-editor', {
      capturePointerEvents: true,
      clampToScreen: true,
      offsetPx: { x: 320, y: -120 },
      marginPx: 24,
    });

    this._overlayHandle = h;

    const container = h.el;
    container.id = 'map-shine-light-editor';
    container.classList.add('map-shine-overlay-ui');
    container.style.pointerEvents = 'auto';
    container.style.userSelect = 'none';
    container.style.webkitUserSelect = 'none';
    container.style.width = '0px';
    container.style.height = '0px';

    const panel = document.createElement('div');
    panel.classList.add('map-shine-light-editor-panel');
    panel.style.cssText = `
      position: absolute;
      left: 0px;
      top: 0px;
      transform: translate(-50%, -50%);
      width: ${this._panelWidth}px;
      padding: 12px;
      border-radius: 12px;
      background: rgba(20, 20, 24, 0.94);
      border: 1px solid rgba(255,255,255,0.14);
      box-shadow: 0 14px 40px rgba(0,0,0,0.60);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      font-family: var(--font-primary, 'Signika', sans-serif);
      color: rgba(255,255,255,0.88);
      pointer-events: auto;
      display: none;
    `;

    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
      panel.addEventListener(type, (e) => {
        _stopPropagationOnly(e);
      });
    }
    panel.addEventListener('contextmenu', _stopAndPrevent);

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
      cursor: move;
      user-select: none;
      -webkit-user-select: none;
    `;

    // Drag-to-reposition (screen-locked) behavior.
    header.addEventListener('pointerdown', (e) => this._beginHeaderDrag(e));

    const title = document.createElement('div');
    title.style.cssText = `
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 0.2px;
      color: rgba(80, 200, 255, 0.95);
    `;
    title.textContent = 'Light Editor';
    this._titleEl = title;

    const btnClose = document.createElement('button');
    btnClose.textContent = '×';
    btnClose.style.cssText = `
      width: 28px;
      height: 24px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.9);
      cursor: pointer;
      font-size: 14px;
    `;
    btnClose.addEventListener('click', (e) => {
      _stopAndPrevent(e);
      this.hide();
    });

    header.appendChild(title);
    header.appendChild(btnClose);

    // Warning banner for enhancements
    const warning = document.createElement('div');
    warning.style.cssText = `
      display: none;
      padding: 8px 10px;
      margin-bottom: 10px;
      border-radius: 8px;
      border: 1px solid rgba(255, 200, 80, 0.45);
      background: rgba(255, 190, 70, 0.12);
      color: rgba(255, 230, 190, 0.95);
      font-size: 11px;
      line-height: 1.35;
    `;
    warning.textContent = 'This light uses MapShine Advanced features.';
    this._warningEl = warning;

    // Body (Tweakpane container)
    const body = document.createElement('div');
    body.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 0;
      max-height: 500px;
      overflow: auto;
      padding-right: 4px;
    `;

    panel.appendChild(header);
    panel.appendChild(warning);
    panel.appendChild(body);
    container.appendChild(panel);

    this.container = container;
    this._panel = panel;
    this._paneContainer = body;

    this._registerHooks();

    this.hide();
    log.info('LightEditorTweakpane initialized');
  }

  _ensurePane(lightType, isDarkness, currentAnimType) {
    if (!this._paneContainer || typeof Tweakpane === 'undefined') return;

    const options = _buildAnimationOptions(isDarkness, currentAnimType);
    const optionsKey = `${String(lightType || 'unknown')}:${isDarkness ? 'dark' : 'light'}:${options.map((o) => o.value).join('|')}`;

    if (this._pane && this._paneOptionsKey === optionsKey) return;

    try { this._pane?.dispose?.(); } catch (_) {}

    this._paneOptionsKey = optionsKey;
    this._bindings.clear();
    this._paneContainer.innerHTML = '';

    this._pane = new Tweakpane.Pane({
      title: '',
      container: this._paneContainer,
      expanded: true
    });

    try {
      const headerEl = this._pane.element?.querySelector?.('.tp-rotv');
      if (headerEl) headerEl.style.display = 'none';
    } catch (_) {}

    // Core folder
    const core = this._pane.addFolder({ title: 'Core', expanded: true });

    this._addBinding(core, 'enabled', { label: 'Enabled' });
    this._addBinding(core, 'negative', { label: 'Darkness' });
    this._addBinding(core, 'color', { label: 'Color' });

    // Only Foundry lights currently support these core LightData fields.
    // Enhanced lights don't expose them in EnhancedLightsApi yet, so avoid misleading UI.
    if (lightType === 'foundry') {
      this._addBinding(core, 'priority', { label: 'Priority', min: 0, max: 20, step: 1 });
      this._addBinding(core, 'angle', { label: 'Angle', min: 0, max: 360, step: 1 });
    }
    this._addBinding(core, 'dim', { label: 'Dim Radius', min: 0, max: 200, step: 1 });
    this._addBinding(core, 'bright', { label: 'Bright Radius', min: 0, max: 200, step: 1 });
    this._addBinding(core, 'alpha', { label: 'Alpha', min: 0, max: 1, step: 0.05 });
    this._addBinding(core, 'attenuation', { label: 'Attenuation', min: 0, max: 1, step: 0.05 });
    this._addBinding(core, 'luminosity', { label: 'Luminosity', min: 0, max: 1, step: 0.05 });

    // Advanced (Foundry core LightData shaping)
    if (lightType === 'foundry') {
      const adv = this._pane.addFolder({ title: 'Advanced', expanded: false });
      this._addBinding(adv, 'coloration', { label: 'Coloration', min: 0, max: 6, step: 1 });
      this._addBinding(adv, 'saturation', { label: 'Saturation', min: -1, max: 1, step: 0.05 });
      this._addBinding(adv, 'contrast', { label: 'Contrast', min: -1, max: 1, step: 0.05 });
      this._addBinding(adv, 'shadows', { label: 'Shadows', min: 0, max: 1, step: 0.05 });
      this._addBinding(adv, 'darknessMin', { label: 'Darkness Min', min: 0, max: 1, step: 0.01 });
      this._addBinding(adv, 'darknessMax', { label: 'Darkness Max', min: 0, max: 1, step: 0.01 });
    }

    // Animation folder
    const anim = this._pane.addFolder({ title: 'Animation', expanded: false });

    const animTypeBinding = anim.addBinding(this._params, 'animType', {
      label: 'Type',
      options: _optionsToMap(options)
    });
    this._bindings.set('animType', animTypeBinding);
    animTypeBinding.on('change', (ev) => this._applyValue('animType', ev.value));

    this._addBinding(anim, 'animSpeed', { label: 'Speed', min: 0, max: 10, step: 0.1 });
    this._addBinding(anim, 'animIntensity', { label: 'Intensity', min: 0, max: 10, step: 0.1 });
    this._addBinding(anim, 'animReverse', { label: 'Reverse' });

    // Cookie folder
    const cookie = this._pane.addFolder({ title: 'Cookie Texture', expanded: true });

    this._addBinding(cookie, 'cookieEnabled', { label: 'Enabled' });
    
    // Cookie texture path with browse button
    this._addBinding(cookie, 'cookieTexture', { label: 'Path' });
    
    // Add browse button
    cookie.addButton({ title: 'Browse...' }).on('click', () => this._browseCookie());

    this._addBinding(cookie, 'cookieStrength', { label: 'Strength', min: 0, max: 3, step: 0.1 });
    this._addBinding(cookie, 'cookieContrast', { label: 'Contrast', min: 0, max: 3, step: 0.1 });
    this._addBinding(cookie, 'cookieGamma', { label: 'Gamma', min: 0.1, max: 3, step: 0.1 });
    this._addBinding(cookie, 'cookieInvert', { label: 'Invert' });
    this._addBinding(cookie, 'cookieColorize', { label: 'Colorize' });
    this._addBinding(cookie, 'cookieTint', { label: 'Tint' });

    // Output shaping folder
    const output = this._pane.addFolder({ title: 'Output Shaping', expanded: false });

    this._addBinding(output, 'outputGain', { label: 'Gain', min: 0, max: 3, step: 0.05 });
    this._addBinding(output, 'outerWeight', { label: 'Outer Weight', min: 0, max: 3, step: 0.05 });
    this._addBinding(output, 'innerWeight', { label: 'Inner Weight', min: 0, max: 3, step: 0.05 });

    // Target layers
    output.addBinding(this._params, 'targetLayers', {
      label: 'Target',
      options: { 'Both': 'both', 'Ground Only': 'ground', 'Overhead Only': 'overhead' }
    }).on('change', (ev) => this._applyValue('targetLayers', ev.value));

    // Sun/Darkness response folder
    const sun = this._pane.addFolder({ title: 'Darkness Response', expanded: false });

    this._addBinding(sun, 'sunEnabled', { label: 'Enabled' });
    this._addBinding(sun, 'sunInvert', { label: 'Invert (day=1)' });
    this._addBinding(sun, 'sunExponent', { label: 'Exponent', min: 0.1, max: 5, step: 0.1 });
    this._addBinding(sun, 'sunMin', { label: 'Min', min: 0, max: 1, step: 0.05 });
    this._addBinding(sun, 'sunMax', { label: 'Max', min: 0, max: 1, step: 0.05 });

    // Delete button
    this._pane.addButton({ title: 'Delete Light' }).on('click', () => this._deleteLight());
  }

  _addBinding(folder, key, opts) {
    const binding = folder.addBinding(this._params, key, opts);
    this._bindings.set(key, binding);
    binding.on('change', (ev) => this._applyValue(key, ev.value));
    return binding;
  }

  _refreshBindings() {
    for (const binding of this._bindings.values()) {
      try { binding.refresh(); } catch (_) {}
    }
  }

  async _browseCookie() {
    try {
      const filePickerImpl = globalThis.foundry?.applications?.apps?.FilePicker?.implementation;
      const FilePickerCls = filePickerImpl ?? globalThis.FilePicker;
      if (!FilePickerCls) {
        ui?.notifications?.warn?.('FilePicker not available');
        return;
      }

      const picker = new FilePickerCls({
        type: 'image',
        current: this._params.cookieTexture || DEFAULT_COOKIE_TEXTURE,
        callback: async (path) => {
          if (path) {
            this._params.cookieTexture = path;
            this._params.cookieEnabled = true;
            this._refreshBindings();
            await this._applyValue('cookieTexture', path);
            await this._applyValue('cookieEnabled', true);
          }
        }
      });
      picker.render(true);
    } catch (err) {
      log.debug('browse cookie failed', err);
    }
  }

  async _deleteLight() {
    if (!this.current) return;

    try {
      if (this.current.type === 'enhanced') {
        const api = window.MapShine?.enhancedLights;
        if (api) {
          await api.delete(this.current.id);
        }
      } else if (this.current.type === 'foundry') {
        const doc = canvas?.scene?.lights?.get?.(this.current.id) || canvas?.lighting?.get?.(this.current.id)?.document;
        if (doc) {
          await doc.delete();
        }
      }
      this.hide();
    } catch (err) {
      log.debug('delete light failed', err);
    }
  }

  hide() {
    this.current = null;
    this._anchorObject = null;

    try { if (this._panel) this._panel.style.display = 'none'; } catch (_) {}

    this.overlayManager.setVisible('light-editor', false);
    this.overlayManager.setAnchorObject('light-editor', null);
    this.overlayManager.setAnchorWorld('light-editor', null);
    this.overlayManager.unlockOverlay('light-editor');

    this._drag.active = false;
    this._endHeaderDragListeners();
  }

  /**
   * @param {{type:'foundry'|'enhanced', id:string}} selection
   * @param {THREE.Object3D|null} anchorObject
   */
  async show(selection, anchorObject) {
    this.initialize();

    this.current = selection;
    this._anchorObject = anchorObject || null;

    this.overlayManager.setVisible('light-editor', true);

    // Option A: This editor is always screen-floating and never anchored to a light.
    // Use a persisted per-light screen position if available; otherwise use a stable default.
    this.overlayManager.setAnchorObject('light-editor', null);
    this.overlayManager.setAnchorWorld('light-editor', null);

    // If the user has positioned this editor before, respect that and keep it screen-locked.
    const persisted = this._getPersistedScreenPos(this.current.id);
    if (persisted) {
      this.overlayManager.lockOverlay('light-editor', persisted);
    } else {
      const defaultPos = { x: Math.round(window.innerWidth * 0.72), y: Math.round(window.innerHeight * 0.28) };
      this.overlayManager.lockOverlay('light-editor', defaultPos);
    }

    try { if (this._panel) this._panel.style.display = 'block'; } catch (_) {}

    await this._refreshFromSource();
  }

  async _refreshFromSource() {
    if (!this.current) return;

    this._suppressInput = true;

    try {
      if (this.current.type === 'enhanced') {
        const api = window.MapShine?.enhancedLights;
        if (!api) return;

        const data = await api.get(this.current.id);
        if (!data) return;

        const photo = _isObject(data.photometry) ? data.photometry : {};
        const anim = _isObject(data.animation) ? data.animation : {};
        const sun = _isObject(data.darknessResponse) ? data.darknessResponse : {};

        this._ensurePane('enhanced', data.isDarkness === true, anim.type ?? '');

        // Update title
        if (this._titleEl) this._titleEl.textContent = 'Enhanced Light';

        // Core
        this._params.enabled = data.enabled !== false;
        this._params.negative = data.isDarkness === true;
        this._params.color = _toCssColor(data.color, '#ffffff');
        // Fields not currently represented in EnhancedLightsApi are kept as defaults.
        this._params.dim = photo.dim ?? 30;
        this._params.bright = photo.bright ?? 15;
        this._params.alpha = photo.alpha ?? 0.5;
        this._params.attenuation = photo.attenuation ?? 0.5;
        this._params.luminosity = photo.luminosity ?? 0.5;

        // Animation
        this._params.animType = anim.type ?? '';
        this._params.animSpeed = anim.speed ?? 5;
        this._params.animIntensity = anim.intensity ?? 5;
        this._params.animReverse = anim.reverse === true;

        // Cookie
        this._params.cookieEnabled = data.cookieEnabled === true;
        this._params.cookieTexture = data.cookieTexture || DEFAULT_COOKIE_TEXTURE;
        this._params.cookieStrength = data.cookieStrength ?? 1.0;
        this._params.cookieContrast = data.cookieContrast ?? 1.0;
        this._params.cookieGamma = data.cookieGamma ?? 1.0;
        this._params.cookieInvert = data.cookieInvert === true;
        this._params.cookieColorize = data.cookieColorize === true;
        this._params.cookieTint = _toCssColor(data.cookieTint, '#ffffff');

        // Output
        this._params.outputGain = data.outputGain ?? 1.0;
        this._params.outerWeight = data.outerWeight ?? 1.0;
        this._params.innerWeight = data.innerWeight ?? 1.0;
        this._params.targetLayers = data.targetLayers || 'both';

        // Sun
        this._params.sunEnabled = sun.enabled === true;
        this._params.sunInvert = sun.invert !== false;
        this._params.sunExponent = sun.exponent ?? 1.0;
        this._params.sunMin = sun.min ?? 0.0;
        this._params.sunMax = sun.max ?? 1.0;

        // Hide warning for enhanced lights (they're always MapShine)
        if (this._warningEl) this._warningEl.style.display = 'none';

        this._refreshBindings();
        return;
      }

      if (this.current.type === 'foundry') {
        const doc = canvas?.scene?.lights?.get?.(this.current.id) || canvas?.lighting?.get?.(this.current.id)?.document;
        if (!doc) return;

        const cfg = doc.config || {};
        const anim = cfg.animation || {};

        // Get enhancement data
        const enhancementStore = window.MapShine?.lightEnhancementStore;
        const enhancement = enhancementStore?.get
          ? await enhancementStore.get(doc.id)
          : enhancementStore?.getCached?.(doc.id);
        const enhCfg = enhancement?.config ?? {};
        const sun = _isObject(enhCfg.darknessResponse) ? enhCfg.darknessResponse : {};

        const isDarkness = (cfg.negative === true) || (doc.negative === true);
        this._ensurePane('foundry', isDarkness, anim.type ?? '');

        // Update title
        if (this._titleEl) this._titleEl.textContent = 'Foundry Light';

        // Core
        this._params.enabled = !doc.hidden;
        this._params.negative = isDarkness;
        this._params.color = _toCssColor(cfg.color, '#ffffff');
        this._params.priority = Number(cfg.priority ?? 0);
        this._params.angle = Number(cfg.angle ?? 360);
        this._params.dim = Number(cfg.dim ?? 30);
        this._params.bright = Number(cfg.bright ?? 15);
        this._params.alpha = Number(cfg.alpha ?? 0.5);
        this._params.attenuation = Number(cfg.attenuation ?? 0.5);
        this._params.luminosity = Number(cfg.luminosity ?? 0.5);

        this._params.coloration = Number(cfg.coloration ?? 1);
        this._params.saturation = Number(cfg.saturation ?? 0);
        this._params.contrast = Number(cfg.contrast ?? 0);
        this._params.shadows = Number(cfg.shadows ?? 0);

        const dr = _isObject(cfg.darkness) ? cfg.darkness : {};
        this._params.darknessMin = Number(dr.min ?? 0.0);
        this._params.darknessMax = Number(dr.max ?? 1.0);

        // Animation
        this._params.animType = anim.type ?? '';
        this._params.animSpeed = anim.speed ?? 5;
        this._params.animIntensity = anim.intensity ?? 5;
        this._params.animReverse = anim.reverse === true;

        // Cookie (from enhancement)
        const hasCookieTex = (typeof enhCfg.cookieTexture === 'string' && enhCfg.cookieTexture.trim());
        // Mirror renderer behavior in ThreeLightSource._updateCookieFromConfig.
        this._params.cookieEnabled = (enhCfg.cookieEnabled === true) || (enhCfg.cookieEnabled === undefined && !!hasCookieTex);
        this._params.cookieTexture = (hasCookieTex ? enhCfg.cookieTexture.trim() : DEFAULT_COOKIE_TEXTURE);
        this._params.cookieStrength = _asFiniteNumber(enhCfg.cookieStrength, 1.0);
        this._params.cookieContrast = _asFiniteNumber(enhCfg.cookieContrast, 1.0);
        this._params.cookieGamma = _asFiniteNumber(enhCfg.cookieGamma, 1.0);
        this._params.cookieInvert = enhCfg.cookieInvert === true;
        this._params.cookieColorize = enhCfg.cookieColorize === true;
        this._params.cookieTint = _toCssColor(enhCfg.cookieTint, '#ffffff');

        // Output (from enhancement)
        this._params.outputGain = _asFiniteNumber(enhCfg.outputGain, 1.0);
        this._params.outerWeight = _asFiniteNumber(enhCfg.outerWeight, 0.5);
        this._params.innerWeight = _asFiniteNumber(enhCfg.innerWeight, 0.5);
        this._params.targetLayers = enhCfg.targetLayers || 'both';

        // Sun (from enhancement)
        this._params.sunEnabled = sun.enabled === true;
        this._params.sunInvert = sun.invert !== false;
        this._params.sunExponent = sun.exponent ?? 1.0;
        this._params.sunMin = sun.min ?? 0.0;
        this._params.sunMax = sun.max ?? 1.0;

        // Show warning if enhancements are active
        const hasEnhancements = enhCfg.cookieEnabled || enhCfg.outputGain !== 1.0 || 
                                enhCfg.outerWeight !== 1.0 || enhCfg.innerWeight !== 1.0 || 
                                sun.enabled || enhCfg.targetLayers !== 'both';
        if (this._warningEl) {
          this._warningEl.style.display = hasEnhancements ? 'block' : 'none';
        }

        this._refreshBindings();
      }
    } catch (err) {
      log.debug('refresh failed', err);
    } finally {
      this._suppressInput = false;
    }
  }

  async _applyValue(key, value) {
    if (!this.current || this._suppressInput) return;

    this._applyInFlight++;
    try {
      if (this.current.type === 'enhanced') {
        const api = window.MapShine?.enhancedLights;
        if (!api) return;

        const id = this.current.id;
        const cur = await api.get(id);
        const update = {};

        // Core fields
        if (key === 'enabled') update.enabled = value === true;
        if (key === 'negative') update.isDarkness = value === true;
        if (key === 'color') update.color = String(value || '#ffffff');

        // Photometry fields
        if (['dim', 'bright', 'alpha', 'attenuation', 'luminosity'].includes(key)) {
          const v = parseFloat(value);
          if (Number.isFinite(v)) {
            update.photometry = { [key]: v };
          }
        }

        // Animation fields
        if (key === 'animType' || key === 'animSpeed' || key === 'animIntensity' || key === 'animReverse') {
          const a0 = _isObject(cur?.animation) ? cur.animation : {};
          const a = { ...a0 };
          if (key === 'animType') a.type = String(value || '').trim() || null;
          if (key === 'animSpeed') a.speed = _asFiniteNumber(value, 5);
          if (key === 'animIntensity') a.intensity = _asFiniteNumber(value, 5);
          if (key === 'animReverse') a.reverse = value === true;
          update.animation = a;
        }

        // Cookie fields
        if (key === 'cookieEnabled') {
          const enabled = value === true;
          update.cookieEnabled = enabled;
          if (enabled) {
            const existingTex = (typeof cur?.cookieTexture === 'string' && cur.cookieTexture.trim())
              ? cur.cookieTexture.trim()
              : '';
            // If no texture was previously set, apply the default so cookies are visible.
            if (!existingTex) update.cookieTexture = DEFAULT_COOKIE_TEXTURE;
          }
        }
        if (key === 'cookieTexture') {
          update.cookieTexture = String(value || '').trim() || DEFAULT_COOKIE_TEXTURE;
          update.cookieEnabled = true;
        }
        if (key === 'cookieStrength') update.cookieStrength = _asFiniteNumber(value, 1.0);
        if (key === 'cookieContrast') update.cookieContrast = _asFiniteNumber(value, 1.0);
        if (key === 'cookieGamma') update.cookieGamma = _asFiniteNumber(value, 1.0);
        if (key === 'cookieInvert') update.cookieInvert = value === true;
        if (key === 'cookieColorize') update.cookieColorize = value === true;
        if (key === 'cookieTint') update.cookieTint = String(value || '#ffffff');

        // Output fields
        if (key === 'outputGain') update.outputGain = _asFiniteNumber(value, 1.0);
        if (key === 'outerWeight') update.outerWeight = _asFiniteNumber(value, 0.5);
        if (key === 'innerWeight') update.innerWeight = _asFiniteNumber(value, 0.5);
        if (key === 'targetLayers') update.targetLayers = String(value || 'both');

        // Sun fields
        if (key.startsWith('sun')) {
          const s0 = _isObject(cur?.darknessResponse) ? cur.darknessResponse : {};
          const s = { ...s0 };
          if (key === 'sunEnabled') s.enabled = value === true;
          if (key === 'sunInvert') s.invert = value === true;
          if (key === 'sunExponent') s.exponent = _asFiniteNumber(value, 1.0);
          if (key === 'sunMin') s.min = _clamp(parseFloat(value) || 0, 0, 1);
          if (key === 'sunMax') s.max = _clamp(_asFiniteNumber(value, 1), 0, 1);
          update.darknessResponse = s;
        }

        if (Object.keys(update).length > 0) {
          await api.update(id, update);
          // Re-read authoritative stored state (and normalize types) after update.
          this._scheduleRefresh();
        }
        return;
      }

      if (this.current.type === 'foundry') {
        const doc = canvas?.scene?.lights?.get?.(this.current.id) || canvas?.lighting?.get?.(this.current.id)?.document;
        if (!doc) return;

        const enhancementStore = window.MapShine?.lightEnhancementStore;
        const docUpdate = {};

        // Core fields (update Foundry doc)
        if (key === 'enabled') docUpdate.hidden = !(value === true);
        if (key === 'negative') docUpdate['config.negative'] = value === true;
        if (key === 'color') docUpdate['config.color'] = String(value || '#ffffff');
        if (key === 'priority') docUpdate['config.priority'] = Math.max(0, Math.floor(Number(value) || 0));
        if (key === 'angle') docUpdate['config.angle'] = _clamp(Number(value) || 0, 0, 360);

        // Photometry fields (update Foundry doc)
        if (['dim', 'bright', 'alpha', 'attenuation', 'luminosity'].includes(key)) {
          const v = parseFloat(value);
          if (Number.isFinite(v)) {
            docUpdate[`config.${key}`] = v;
          }
        }

        // Advanced shaping fields (update Foundry doc)
        if (['coloration', 'saturation', 'contrast', 'shadows'].includes(key)) {
          const v = parseFloat(value);
          if (Number.isFinite(v)) {
            docUpdate[`config.${key}`] = v;
          }
        }

        // Darkness range (update Foundry doc)
        if (key === 'darknessMin') {
          const v = parseFloat(value);
          if (Number.isFinite(v)) docUpdate['config.darkness.min'] = _clamp(v, 0, 1);
        }
        if (key === 'darknessMax') {
          const v = parseFloat(value);
          if (Number.isFinite(v)) docUpdate['config.darkness.max'] = _clamp(v, 0, 1);
        }

        // Animation fields (update Foundry doc)
        if (key === 'animType' || key === 'animSpeed' || key === 'animIntensity' || key === 'animReverse') {
          const curAnim = doc.config?.animation ?? {};
          const next = { ...curAnim };
          if (key === 'animType') next.type = String(value || '').trim() || null;
          if (key === 'animSpeed') next.speed = _asFiniteNumber(value, 5);
          if (key === 'animIntensity') next.intensity = _asFiniteNumber(value, 5);
          if (key === 'animReverse') next.reverse = value === true;
          docUpdate['config.animation'] = next;
        }

        // Update Foundry doc if we have changes
        if (Object.keys(docUpdate).length > 0) {
          await doc.update(docUpdate);
          // Ensure we re-read the authoritative, cleaned document state.
          this._scheduleRefresh();
        }

        // Enhancement fields (update via LightEnhancementStore)
        if (enhancementStore?.upsert) {
          const enhUpdate = {};
          let existingEntry = null;
          let existingConfig = null;

          // Cookie fields
          if (key === 'cookieEnabled') {
            const enabled = value === true;
            enhUpdate.cookieEnabled = enabled;
            if (enabled) {
              existingEntry = enhancementStore.get
                ? await enhancementStore.get(doc.id)
                : enhancementStore.getCached?.(doc.id);
              existingConfig = existingEntry?.config ?? null;
              const existingTex = (typeof existingConfig?.cookieTexture === 'string' && existingConfig.cookieTexture.trim())
                ? existingConfig.cookieTexture.trim()
                : '';
              if (!existingTex) enhUpdate.cookieTexture = DEFAULT_COOKIE_TEXTURE;
            }
          }
          if (key === 'cookieTexture') {
            enhUpdate.cookieTexture = String(value || '').trim() || DEFAULT_COOKIE_TEXTURE;
            enhUpdate.cookieEnabled = true;
          }
          if (key === 'cookieStrength') enhUpdate.cookieStrength = _asFiniteNumber(value, 1.0);
          if (key === 'cookieContrast') enhUpdate.cookieContrast = _asFiniteNumber(value, 1.0);
          if (key === 'cookieGamma') enhUpdate.cookieGamma = _asFiniteNumber(value, 1.0);
          if (key === 'cookieInvert') enhUpdate.cookieInvert = value === true;
          if (key === 'cookieColorize') enhUpdate.cookieColorize = value === true;
          if (key === 'cookieTint') enhUpdate.cookieTint = String(value || '#ffffff');

          // Output fields
          if (key === 'outputGain') enhUpdate.outputGain = _asFiniteNumber(value, 1.0);
          if (key === 'outerWeight') enhUpdate.outerWeight = _asFiniteNumber(value, 0.5);
          if (key === 'innerWeight') enhUpdate.innerWeight = _asFiniteNumber(value, 0.5);
          if (key === 'targetLayers') enhUpdate.targetLayers = String(value || 'both');

          // Sun fields
          if (key.startsWith('sun')) {
            if (!existingConfig) {
              existingEntry = enhancementStore.get
                ? await enhancementStore.get(doc.id)
                : enhancementStore.getCached?.(doc.id);
              existingConfig = existingEntry?.config ?? {};
            }
            const existing = existingConfig ?? {};
            const s0 = _isObject(existing.darknessResponse) ? existing.darknessResponse : {};
            const s = { ...s0 };
            if (key === 'sunEnabled') s.enabled = value === true;
            if (key === 'sunInvert') s.invert = value === true;
            if (key === 'sunExponent') s.exponent = _asFiniteNumber(value, 1.0);
            if (key === 'sunMin') s.min = _clamp(parseFloat(value) || 0, 0, 1);
            if (key === 'sunMax') s.max = _clamp(_asFiniteNumber(value, 1), 0, 1);
            enhUpdate.darknessResponse = s;
          }

          if (Object.keys(enhUpdate).length > 0) {
            await enhancementStore.upsert(doc.id, enhUpdate);
            // Enhancement writes go through scene flags; schedule refresh for final state.
            this._scheduleRefresh();
          }
        }
      }
    } catch (err) {
      log.debug('apply value failed', err);
    } finally {
      this._applyInFlight = Math.max(0, (this._applyInFlight || 1) - 1);

      if (this._applyInFlight === 0 && this._pendingRefresh) {
        this._pendingRefresh = false;
        this._scheduleRefresh();
      }
    }
  }

  update(_timeInfo) {
    if (!this.current) return;
    if (this.current.type !== 'foundry') return;

    try {
      const doc = canvas?.scene?.lights?.get?.(this.current.id) || canvas?.lighting?.get?.(this.current.id)?.document;
      if (!doc) return;
      if (!window.THREE) return;
      if (!this._tmpAnchorWorld) this._tmpAnchorWorld = new window.THREE.Vector3();

      const groundZ = window.MapShine?.sceneComposer?.groundZ ?? this.overlayManager?.sceneComposer?.groundZ ?? 0;
      const anchorZ = groundZ + 0.5;

      const w = Coordinates.toWorld(doc.x, doc.y);
      w.z = anchorZ;
      this._tmpAnchorWorld.copy(w);
      this.overlayManager.setAnchorWorld('light-editor', this._tmpAnchorWorld);
    } catch (_) {}
  }

  dispose() {
    try { this.hide(); } catch (_) {}
    try { this._pane?.dispose?.(); } catch (_) {}

    this.container = null;
    this._panel = null;
    this._paneContainer = null;
    this._pane = null;
    this._bindings.clear();
  }
}
