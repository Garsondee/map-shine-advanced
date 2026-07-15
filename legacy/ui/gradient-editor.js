/**
 * @fileoverview Canvas-based gradient-over-lifespan editor widget.
 *
 * Renders an interactive gradient strip with draggable colour stops.
 * Designed to be injected into the Tweakpane DOM after an anchor blade.
 *
 * Stops format: { t, r, g, b } — channels stored as 0–1 floats (legacy 0–255 is normalized on load).
 * For emission gradients use the same format: black (0,0,0) = no tint; colour is
 * added to diffuse smoke in the effect then clamped to display-referred [0,1].
 *
 * Interaction:
 *   - Click gradient strip          → add interpolated stop at that position
 *   - Drag handle                   → move stop along time axis
 *   - Double-click handle           → open Tweakpane colour picker popup
 *   - Right-click handle            → delete stop (minimum 2 stops enforced)
 *
 * @module ui/gradient-editor
 */

import { normalizeEffectRgbParam } from './parameter-validator.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const CANVAS_HEIGHT = 28;
const HANDLE_AREA_HEIGHT = 28;
const HANDLE_RADIUS = 7;
const MIN_STOPS = 2;
const DRAG_THRESHOLD = 4; // px before a click becomes a drag

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clamp v to [min, max]. */
function _clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** Return a finite number or the provided fallback. */
function _finiteOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/** Convert linear 0–1 r,g,b to a CSS hex string. */
function _toHex(r, g, b) {
  const ri = Math.round(_clamp(_finiteOr(r, 0), 0, 1) * 255);
  const gi = Math.round(_clamp(_finiteOr(g, 0), 0, 1) * 255);
  const bi = Math.round(_clamp(_finiteOr(b, 0), 0, 1) * 255);
  return `#${ri.toString(16).padStart(2, '0')}${gi.toString(16).padStart(2, '0')}${bi.toString(16).padStart(2, '0')}`;
}

/** Sample a colour stop array at t ∈ [0,1], returns interpolated {r,g,b}. */
function _sampleColorStops(stops, t) {
  if (!stops || stops.length === 0) return { r: 1, g: 1, b: 1 };
  if (stops.length === 1) {
    return {
      r: _finiteOr(stops[0].r, 0),
      g: _finiteOr(stops[0].g, 0),
      b: _finiteOr(stops[0].b, 0),
    };
  }
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1].t <= t) i++;
  if (i >= stops.length - 1) {
    const s = stops[stops.length - 1];
    return {
      r: _finiteOr(s.r, 0),
      g: _finiteOr(s.g, 0),
      b: _finiteOr(s.b, 0),
    };
  }
  const a = stops[i];
  const bStop = stops[i + 1];
  const ar = _finiteOr(a.r, 0);
  const ag = _finiteOr(a.g, 0);
  const ab = _finiteOr(a.b, 0);
  const br = _finiteOr(bStop.r, 0);
  const bg = _finiteOr(bStop.g, 0);
  const bb = _finiteOr(bStop.b, 0);
  const f = (t - a.t) / Math.max(1e-4, bStop.t - a.t);
  return {
    r: ar + (br - ar) * f,
    g: ag + (bg - ag) * f,
    b: ab + (bb - ab) * f,
  };
}

// ── GradientEditor ────────────────────────────────────────────────────────────

/**
 * Interactive gradient-over-lifespan editor injected as a DOM element into a
 * Tweakpane folder.
 *
 * @example
 * const editor = new GradientEditor(parentEl, {
 *   label: 'Smoke Colour',
 *   stops: [{ t:0, r:1, g:0.5, b:0.1 }, { t:1, r:0.2, g:0.2, b:0.2 }],
 *   onChange: (stops) => effect.params.smokeColorGradient = stops,
 * });
 */
export class GradientEditor {
  /**
   * @param {HTMLElement} parentEl   - Container to append the editor into
   * @param {object} options
   * @param {string}   [options.label]    - Label shown above the gradient
   * @param {Array}    options.stops      - Initial stop array { t, r, g, b }
   * @param {Function} options.onChange   - Called with the new stops array on any edit
   */
  constructor(parentEl, options = {}) {
    this._parent = parentEl;
    this._label = options.label ?? 'Gradient';
    this._stops = this._cloneStops(options.stops ?? this._defaultStops());
    this._onChange = options.onChange ?? (() => {});

    this._selected = null;       // index of selected stop
    this._destroyed = false;

    // Tweakpane colour picker popup state
    this._pickerPane = null;
    this._pickerEl = null;
    this._pickerCloseHandler = null;
    this._notifyDebounceTimer = null;
    this._resizeObserver = null;

    this._buildDOM();
    this._render();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Replace stops programmatically (e.g. on preset load). */
  setStops(stops) {
    this._stops = this._cloneStops(stops ?? this._defaultStops());
    this._selected = null;
    this._render();
  }

  /** Return a deep copy of the current stops. */
  getStops() {
    return this._cloneStops(this._stops);
  }

  /** Remove the editor from the DOM and tear down all listeners. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._notifyDebounceTimer) {
      clearTimeout(this._notifyDebounceTimer);
      this._notifyDebounceTimer = null;
    }
    if (this._resizeObserver) {
      try { this._resizeObserver.disconnect(); } catch (_) {}
      this._resizeObserver = null;
    }
    this._destroyColorPicker();
    this._root?.remove();
    this._root = null;
  }

  // ── DOM Construction ────────────────────────────────────────────────────────

  _buildDOM() {
    const root = document.createElement('div');
    root.className = 'ms-gradient-editor';
    root.style.cssText = 'padding:4px 8px 6px 8px;box-sizing:border-box;width:100%;user-select:none;';

    // Label row
    const labelRow = document.createElement('div');
    labelRow.style.cssText = 'font-size:10px;color:var(--tp-base-label-foreground-color,#aaa);margin-bottom:3px;letter-spacing:0.03em;';
    labelRow.textContent = this._label;
    root.appendChild(labelRow);

    // Gradient strip canvas — click here to add stops
    const canvas = document.createElement('canvas');
    canvas.height = CANVAS_HEIGHT;
    canvas.style.cssText = `display:block;width:100%;height:${CANVAS_HEIGHT}px;cursor:crosshair;border-radius:3px;border:1px solid rgba(255,255,255,0.08);`;
    root.appendChild(canvas);
    this._canvas = canvas;

    // Handle area — drag/dblclick/right-click stops here
    const handles = document.createElement('canvas');
    handles.height = HANDLE_AREA_HEIGHT;
    handles.style.cssText = `display:block;width:100%;height:${HANDLE_AREA_HEIGHT}px;cursor:default;margin-top:2px;`;
    root.appendChild(handles);
    this._handleCanvas = handles;

    // Hint text
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:9px;color:rgba(255,255,255,0.25);margin-top:3px;';
    hint.textContent = 'Click strip to add • Dbl-click handle to edit • Right-click handle to remove • Drag to move';
    root.appendChild(hint);

    this._parent.appendChild(root);
    this._root = root;

    // Re-render on layout changes so handle circles keep correct aspect ratio.
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._render());
      this._resizeObserver.observe(root);
    }

    // Defer a couple renders until after Tweakpane/folder layout settles.
    requestAnimationFrame(() => this._render());
    requestAnimationFrame(() => this._render());

    this._wireCanvasEvents();
    this._wireHandleEvents();
  }

  // ── Event Wiring ────────────────────────────────────────────────────────────

  _wireCanvasEvents() {
    // Single click on the gradient strip adds a new interpolated stop.
    this._canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const t = this._xToT(e.offsetX, this._canvas.offsetWidth);
      const { r, g, b } = _sampleColorStops(this._stops, t);
      const newStop = { t, r, g, b };
      this._stops.push(newStop);
      this._sortStops();
      this._selected = this._stops.indexOf(newStop);
      this._destroyColorPicker();
      this._render();
      this._notifyChange();
    });
  }

  _wireHandleEvents() {
    const handles = this._handleCanvas;
    let dragStopRef = null;   // reference to the stop object being dragged
    let dragStartX = 0;
    let dragMoved = false;
    let dragChanged = false;

    handles.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const hitIndex = this._hitTestHandle(e.offsetX, handles.offsetWidth);
      if (hitIndex < 0) return;
      dragStopRef = this._stops[hitIndex];
      dragStartX = e.offsetX;
      dragMoved = false;
      dragChanged = false;
      this._selected = hitIndex;
      handles.setPointerCapture(e.pointerId);
      this._render();
    });

    handles.addEventListener('pointermove', (e) => {
      if (!dragStopRef) return;
      if (Math.abs(e.offsetX - dragStartX) >= DRAG_THRESHOLD) dragMoved = true;
      if (!dragMoved) return;
      dragStopRef.t = _clamp(this._xToT(e.offsetX, handles.offsetWidth), 0, 1);
      this._sortStops();
      this._selected = this._stops.indexOf(dragStopRef);
      dragChanged = true;
      this._render();
    });

    handles.addEventListener('pointerup', (e) => {
      if (!dragStopRef) return;
      handles.releasePointerCapture(e.pointerId);
      if (dragChanged) this._notifyChange();
      dragStopRef = null;
      dragMoved = false;
      dragChanged = false;
    });

    // Double-click handle opens the Tweakpane colour picker popup.
    handles.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const hitIndex = this._hitTestHandle(e.offsetX, handles.offsetWidth);
      if (hitIndex < 0) return;
      this._selected = hitIndex;
      this._render();
      this._openColorPickerTP(this._stops[hitIndex], e.clientX, e.clientY);
    });

    // Right-click handle removes the stop.
    handles.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const hitIndex = this._hitTestHandle(e.offsetX, handles.offsetWidth);
      if (hitIndex >= 0 && this._stops.length > MIN_STOPS) {
        this._stops.splice(hitIndex, 1);
        if (this._selected !== null && this._selected >= this._stops.length) {
          this._selected = this._stops.length - 1;
        }
        this._destroyColorPicker();
        this._render();
        this._notifyChange();
      }
    });
  }

  // ── Tweakpane Colour Picker Popup ───────────────────────────────────────────

  /**
   * Open a floating Tweakpane pane near (clientX, clientY) for editing stop.
   * Falls back to a hidden native <input type="color"> if Tweakpane is unavailable.
   */
  _openColorPickerTP(stop, clientX, clientY) {
    this._destroyColorPicker();

    const TP = window.Tweakpane;
    if (!TP?.Pane) {
      // Fallback: invisible native color input
      const input = document.createElement('input');
      input.type = 'color';
      input.value = _toHex(stop.r, stop.g, stop.b);
      input.style.cssText = 'position:fixed;opacity:0;pointer-events:none;left:-9999px;top:-9999px;';
      document.body.appendChild(input);
      input.addEventListener('input', (ev) => {
        const hex = ev.target.value;
        const m = /^#([0-9a-f]{6})$/i.exec(hex);
        if (!m) return;
        const v = parseInt(m[1], 16);
        stop.r = ((v >> 16) & 0xff) / 255;
        stop.g = ((v >> 8) & 0xff) / 255;
        stop.b = (v & 0xff) / 255;
        this._render();
        this._notifyChangeDebounced();
      });
      input.addEventListener('change', () => input.remove());
      input.click();
      return;
    }

    // Position popup near the clicked handle, clamp to viewport.
    const vw = window.innerWidth, vh = window.innerHeight;
    const popupW = 250;
    let px = Math.min(clientX, vw - popupW - 8);
    let py = clientY + 14;
    if (py + 180 > vh - 8) py = clientY - 180 - 4;
    px = Math.max(8, px);
    py = Math.max(8, py);

    const popupEl = document.createElement('div');
    popupEl.className = 'ms-gradient-color-popup';
    popupEl.style.cssText = `position:fixed;left:${px}px;top:${py}px;z-index:30000;min-width:${popupW}px;pointer-events:auto;`;
    document.body.appendChild(popupEl);

    // Tweakpane pane with a float-range colour binding
    const rgb0 = normalizeEffectRgbParam({ r: stop.r, g: stop.g, b: stop.b }) ?? {
      r: _clamp(_finiteOr(stop.r, 0), 0, 1),
      g: _clamp(_finiteOr(stop.g, 0), 0, 1),
      b: _clamp(_finiteOr(stop.b, 0), 0, 1),
    };
    const nr = _clamp(rgb0.r, 0, 1);
    const ng = _clamp(rgb0.g, 0, 1);
    const nb = _clamp(rgb0.b, 0, 1);
    const healed =
      Math.abs(nr - _finiteOr(stop.r, 0)) > 1e-5
      || Math.abs(ng - _finiteOr(stop.g, 0)) > 1e-5
      || Math.abs(nb - _finiteOr(stop.b, 0)) > 1e-5;
    stop.r = nr;
    stop.g = ng;
    stop.b = nb;
    const colorObj = { color: { r: stop.r, g: stop.g, b: stop.b } };
    if (healed) {
      this._render();
      this._notifyChangeDebounced();
    }
    const pane = new TP.Pane({ container: popupEl });
    pane.addBinding(colorObj, 'color', {
      label: 'Stop Colour',
      // ObjectColorInputPlugin reads params.color.type, not top-level colorType.
      color: { type: 'float' },
      colorType: 'float',
    }).on('change', (ev) => {
      const rgb = normalizeEffectRgbParam(ev.value);
      if (rgb) {
        stop.r = _clamp(rgb.r, 0, 1);
        stop.g = _clamp(rgb.g, 0, 1);
        stop.b = _clamp(rgb.b, 0, 1);
      }
      this._render();
      this._notifyChangeDebounced();
    });

    // Auto-expand the colour swatch immediately
    setTimeout(() => {
      const swatchBtn = popupEl.querySelector('.tp-colswv');
      if (swatchBtn) swatchBtn.click();
    }, 30);

    this._pickerPane = pane;
    this._pickerEl = popupEl;

    // Close popup on any click outside it
    const closeHandler = (e) => {
      if (!popupEl.contains(e.target)) {
        this._destroyColorPicker();
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', closeHandler, true), 150);
    this._pickerCloseHandler = closeHandler;
  }

  _destroyColorPicker() {
    if (this._pickerCloseHandler) {
      document.removeEventListener('pointerdown', this._pickerCloseHandler, true);
      this._pickerCloseHandler = null;
    }
    if (this._pickerPane) {
      try { this._pickerPane.dispose(); } catch (_) {}
      this._pickerPane = null;
    }
    if (this._pickerEl) {
      this._pickerEl.remove();
      this._pickerEl = null;
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  _render() {
    this._renderGradientStrip();
    this._renderHandles();
  }

  _renderGradientStrip() {
    const canvas = this._canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.offsetWidth || 200;
    const h = CANVAS_HEIGHT;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    if (!this._stops.length) return;

    // addColorStop requires strictly non-decreasing offsets; keep order stable.
    const sorted = [...this._stops].sort((a, b) => a.t - b.t);

    const grd = ctx.createLinearGradient(0, 0, w, 0);
    for (const s of sorted) {
      grd.addColorStop(_clamp(s.t, 0, 1), _toHex(s.r, s.g, s.b));
    }
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);
  }

  _renderHandles() {
    const canvas = this._handleCanvas;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.offsetWidth || 200;
    const h = HANDLE_AREA_HEIGHT;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);

    const cx = h / 2;

    for (let i = 0; i < this._stops.length; i++) {
      const s = this._stops[i];
      const x = _clamp(s.t, 0, 1) * w;
      const selected = i === this._selected;

      // Tick from top of handle area to circle
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cx - HANDLE_RADIUS - 1);
      ctx.strokeStyle = selected ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Circle filled with the stop's colour
      ctx.beginPath();
      ctx.arc(x, cx, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = _toHex(s.r, s.g, s.b);
      ctx.fill();
      ctx.strokeStyle = selected ? '#fff' : 'rgba(255,255,255,0.35)';
      ctx.lineWidth = selected ? 2 : 1;
      ctx.stroke();

      // Hex label below selected handle
      if (selected) {
        ctx.font = '9px monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.textAlign = x > w * 0.8 ? 'right' : (x < w * 0.2 ? 'left' : 'center');
        ctx.fillText(_toHex(s.r, s.g, s.b), x, h - 2);
      }
    }
  }

  // ── Utility ─────────────────────────────────────────────────────────────────

  /** Convert canvas pixel X to gradient t in [0,1]. */
  _xToT(x, canvasW) {
    return _clamp(x / Math.max(1, canvasW), 0, 1);
  }

  /** Hit-test the handle canvas against all stop handles. Returns index or -1. */
  _hitTestHandle(x, canvasW) {
    const cx = HANDLE_AREA_HEIGHT / 2;
    for (let i = 0; i < this._stops.length; i++) {
      const sx = _clamp(this._stops[i].t, 0, 1) * canvasW;
      if (Math.abs(x - sx) <= HANDLE_RADIUS + 2) return i;
    }
    return -1;
  }

  /** Sort stops by ascending t. */
  _sortStops() {
    this._stops.sort((a, b) => a.t - b.t);
  }

  /** Deep-clone a stop array. */
  _cloneStops(stops) {
    if (!Array.isArray(stops) || stops.length === 0) return this._defaultStops();
    const normalized = stops
      .map((s, index) => this._normalizeStop(s, index, stops.length))
      .filter(Boolean)
      .sort((a, b) => a.t - b.t);

    if (normalized.length >= MIN_STOPS) return normalized;
    return this._defaultStops();
  }

  /**
   * Normalize stored stop data into the current color-stop shape.
   * Supports legacy scalar emission stops `{ t, v }` by converting them to
   * grayscale tint where black = none and white = strong (still clamped in-engine).
   */
  _normalizeStop(stop, index, total) {
    if (!stop || typeof stop !== 'object') return null;

    const fallbackT = total <= 1 ? 0 : index / Math.max(1, total - 1);
    const t = _clamp(_finiteOr(stop.t, fallbackT), 0, 1);

    if (Number.isFinite(stop.r) || Number.isFinite(stop.g) || Number.isFinite(stop.b)) {
      const rgb = normalizeEffectRgbParam({
        r: stop.r,
        g: stop.g,
        b: stop.b,
        a: stop.a,
      });
      if (rgb) {
        return {
          t,
          r: _clamp(rgb.r, 0, 1),
          g: _clamp(rgb.g, 0, 1),
          b: _clamp(rgb.b, 0, 1),
        };
      }
      return {
        t,
        r: _clamp(_finiteOr(stop.r, 0), 0, 1),
        g: _clamp(_finiteOr(stop.g, 0), 0, 1),
        b: _clamp(_finiteOr(stop.b, 0), 0, 1),
      };
    }

    if (Number.isFinite(stop.v)) {
      const v = _clamp(stop.v, 0, 1);
      return { t, r: v, g: v, b: v };
    }

    return { t, r: 0, g: 0, b: 0 };
  }

  /** Default stops when none are provided. */
  _defaultStops() {
    return [
      { t: 0, r: 1, g: 1, b: 1 },
      { t: 1, r: 0, g: 0, b: 0 },
    ];
  }

  /** Notify the onChange callback with a cloned copy of the current stops. */
  _notifyChange() {
    try {
      this._onChange(this.getStops());
    } catch (_) {}
  }

  /** Debounced notify used for high-frequency color-picker drags. */
  _notifyChangeDebounced(delayMs = 80) {
    if (this._notifyDebounceTimer) clearTimeout(this._notifyDebounceTimer);
    this._notifyDebounceTimer = setTimeout(() => {
      this._notifyDebounceTimer = null;
      this._notifyChange();
    }, delayMs);
  }
}
