/**
 * @fileoverview LightRingUI
 * A world-anchored radial UI for editing Foundry and MapShine enhanced lights.
 *
 * Design goals:
 * - Single-click selection shows ring.
 * - Dragging wedges edits common params without opening a dialog.
 * - A compact details panel provides access to most remaining fields.
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';

const log = createLogger('LightRingUI');

function _clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function _isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function _parseHexColor(hex) {
  const s = String(hex || '').trim();
  if (!s) return { r: 1, g: 1, b: 1 };

  const m = s.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return { r: 1, g: 1, b: 1 };
  const n = parseInt(m[1], 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

function _rgbToHex({ r, g, b }) {
  const to = (x) => {
    const v = Math.round(_clamp(Number(x) || 0, 0, 1) * 255);
    return v.toString(16).padStart(2, '0');
  };
  return `#${to(r)}${to(g)}${to(b)}`;
}

function _normalizeAngleRad(a) {
  let x = Number(a) || 0;
  while (x <= -Math.PI) x += Math.PI * 2;
  while (x > Math.PI) x -= Math.PI * 2;
  return x;
}

function _polarAngleFromDxDy(dx, dy) {
  // screen-space: +x right, +y down
  return Math.atan2(dy, dx);
}

function _angleToUnit01(theta, startAngle) {
  // Map theta to [0..1) around a circle, with startAngle treated as 0.
  const t = _normalizeAngleRad(theta - startAngle);
  const u = (t + Math.PI) / (Math.PI * 2);
  return (u + 0.5) % 1;
}

function _createEl(tag, cssText) {
  const el = document.createElement(tag);
  if (cssText) el.style.cssText = cssText;
  return el;
}

function _stop(e) {
  try {
    e.stopPropagation();
  } catch (_) {
  }
}

function _stopAndPrevent(e) {
  try {
    e.preventDefault();
  } catch (_) {
  }

  try {
    e.stopPropagation();
  } catch (_) {
  }

  try {
    e.stopImmediatePropagation?.();
  } catch (_) {
  }
}

export class LightRingUI {
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
    this._ringWrapEl = null;

    /** @type {SVGSVGElement|null} */
    this.svg = null;

    /** @type {HTMLElement|null} */
    this.details = null;

    /** @type {Map<string, HTMLElement>} */
    this.fields = new Map();

    /** @type {Map<string, {fill: SVGCircleElement, segLen: number, circ: number}>} */
    this._meters = new Map();

    // Reuse a vector for stable anchoring.
    this._tmpAnchorWorld = null;

    this._drag = {
      active: false,
      wedge: null,
      startClientX: 0,
      startClientY: 0,
      startValue: 0,
      startAngle: 0,
      mode: null, // 'angle' | 'vertical'
    };

    this._overlayLocked = false;

    this._lastAppliedAt = 0;

    this._boundHandlers = {
      onPointerMove: (e) => this._onPointerMove(e),
      onPointerUp: (e) => this._onPointerUp(e),
    };

    // Visual constants
    this._uiSize = 200;
    this._uiCenter = this._uiSize * 0.5;

    // Three concentric rings; each ring is 3 wedges (120° each).
    // This creates large interaction targets and leaves room for more controls.
    this._ringGap = 4;
    this._ringThickness = 16;
    this._rings = [
      // inner
      { rInner: 42, rOuter: 42 + this._ringThickness },
      // mid
      { rInner: 42 + this._ringThickness + this._ringGap, rOuter: 42 + this._ringThickness + this._ringGap + this._ringThickness },
      // outer
      { rInner: 42 + (this._ringThickness + this._ringGap) * 2, rOuter: 42 + (this._ringThickness + this._ringGap) * 2 + this._ringThickness },
    ];

    this._startAngle = -Math.PI / 2; // top

    this._defaultCookieTexture = 'modules/map-shine-advanced/assets/kenney assets/light_01.png';
  }

  initialize() {
    if (this.container) return;

    const h = this.overlayManager.createOverlay('light-ring', {
      capturePointerEvents: true,
      clampToScreen: true,
      offsetPx: { x: 0, y: -10 },
      marginPx: 70,
    });

    const container = h.el;
    container.id = 'map-shine-light-ring';
    container.classList.add('map-shine-overlay-ui');
    container.style.pointerEvents = 'auto';
    container.style.userSelect = 'none';
    container.style.webkitUserSelect = 'none';

    // Allow this overlay to receive pointer events without triggering selection/camera.
    // Use a small set of captures; wheel should not be stolen.
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
      container.addEventListener(type, _stopAndPrevent);
    }
    container.addEventListener('contextmenu', _stopAndPrevent);

    // IMPORTANT: keep the overlay handle itself 0x0 so OverlayUIManager's
    // translate(-50%, -50%) doesn't shift as children (details panel) change size.
    // We center the actual ringWrap manually.
    container.style.width = '0px';
    container.style.height = '0px';

    const ringWrap = _createEl('div', `
      position: absolute;
      left: 0px;
      top: 0px;
      transform: translate(-50%, -50%);
      width: ${this._uiSize}px;
      height: ${this._uiSize}px;
      pointer-events: auto;
    `);

    // If the user interacts with any control inside the ring UI (details inputs, etc.),
    // freeze the overlay position so doc/camera updates can't cause visible drift.
    ringWrap.addEventListener('pointerdown', (e) => {
      try {
        const t = e.target;
        if (!(t instanceof Element)) return;
        if (!t.closest('button, a, input, select, textarea, label')) return;
        this._lockOverlayToCurrentCenter();
      } catch (_) {
      }
    }, { capture: true });

    const svg = /** @type {SVGSVGElement} */(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    svg.setAttribute('width', String(this._uiSize));
    svg.setAttribute('height', String(this._uiSize));
    svg.setAttribute('viewBox', `0 0 ${this._uiSize} ${this._uiSize}`);
    svg.style.position = 'absolute';
    svg.style.left = '0px';
    svg.style.top = '0px';
    svg.style.overflow = 'visible';

    // Base disc behind all rings.
    const baseDisc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    baseDisc.setAttribute('cx', String(this._uiCenter));
    baseDisc.setAttribute('cy', String(this._uiCenter));
    baseDisc.setAttribute('r', String(this._uiCenter));
    baseDisc.setAttribute('fill', 'rgba(12, 12, 14, 0.25)');
    baseDisc.setAttribute('stroke', 'rgba(255,255,255,0.06)');
    baseDisc.setAttribute('stroke-width', '1');
    svg.appendChild(baseDisc);

    const label = _createEl('div', `
      position: absolute;
      left: 0px;
      top: ${Math.round(this._uiCenter - 6)}px;
      width: ${this._uiSize}px;
      text-align: center;
      font-family: var(--font-primary, 'Signika', sans-serif);
      font-size: 12px;
      color: rgba(255,255,255,0.85);
      text-shadow: 0 1px 1px rgba(0,0,0,0.6);
      pointer-events: none;
    `);
    label.textContent = '';

    const details = _createEl('div', `
      position: absolute;
      left: ${this._uiSize + 4}px;
      top: 0px;
      width: 260px;
      padding: 10px 10px;
      border-radius: 10px;
      background: rgba(20, 20, 24, 0.92);
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 10px 30px rgba(0,0,0,0.55);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      font-family: var(--font-primary, 'Signika', sans-serif);
      color: rgba(255,255,255,0.86);
      pointer-events: auto;
      display: none;
    `);

    details.addEventListener('pointerdown', _stopAndPrevent);
    details.addEventListener('click', _stopAndPrevent);

    const header = _createEl('div', `
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    `);

    const title = _createEl('div', `
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 0.2px;
      color: rgba(80, 200, 255, 0.95);
    `);
    title.textContent = 'Light';

    const buttons = _createEl('div', `
      display: flex;
      gap: 6px;
    `);

    const btnToggle = _createEl('button', `
      padding: 4px 8px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.9);
      cursor: pointer;
      font-size: 12px;
    `);
    btnToggle.textContent = 'Hide';

    const btnClose = _createEl('button', `
      padding: 4px 8px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.9);
      cursor: pointer;
      font-size: 12px;
    `);
    btnClose.textContent = '×';

    btnToggle.addEventListener('click', (e) => {
      _stopAndPrevent(e);
      const isOpen = details.style.display !== 'none';
      details.style.display = isOpen ? 'none' : 'block';
      btnToggle.textContent = isOpen ? 'Show' : 'Hide';
    });

    btnClose.addEventListener('click', (e) => {
      _stopAndPrevent(e);
      this.hide();
    });

    buttons.appendChild(btnToggle);
    buttons.appendChild(btnClose);
    header.appendChild(title);
    header.appendChild(buttons);
    details.appendChild(header);

    const body = _createEl('div', `
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      align-items: center;
    `);

    const addField = (key, labelText, inputEl, storeEl = undefined) => {
      const rowLabel = _createEl('div', `
        font-size: 11px;
        opacity: 0.86;
      `);
      rowLabel.textContent = labelText;

      const wrap = _createEl('div', `
        display: flex;
        justify-content: flex-end;
      `);
      wrap.appendChild(inputEl);

      body.appendChild(rowLabel);
      body.appendChild(wrap);
      this.fields.set(key, storeEl || inputEl);
    };

    const makeInput = (type) => {
      const input = /** @type {HTMLInputElement} */(document.createElement('input'));
      input.type = type;
      input.style.width = '100%';
      input.style.maxWidth = '135px';
      input.style.height = '24px';
      input.style.borderRadius = '7px';
      input.style.border = '1px solid rgba(255,255,255,0.14)';
      input.style.background = 'rgba(255,255,255,0.06)';
      input.style.color = 'rgba(255,255,255,0.9)';
      input.style.padding = '0 8px';
      input.style.fontSize = '12px';
      return input;
    };

    const makeSelect = () => {
      const sel = /** @type {HTMLSelectElement} */(document.createElement('select'));
      sel.style.width = '100%';
      sel.style.maxWidth = '135px';
      sel.style.height = '24px';
      sel.style.borderRadius = '7px';
      sel.style.border = '1px solid rgba(255,255,255,0.14)';
      sel.style.background = 'rgba(255,255,255,0.06)';
      sel.style.color = 'rgba(255,255,255,0.9)';
      sel.style.padding = '0 8px';
      sel.style.fontSize = '12px';
      return sel;
    };

    // Details fields. These should cover most editing needs without opening the dialog.
    const enabled = makeInput('checkbox');
    enabled.style.width = '16px';
    enabled.style.maxWidth = '16px';
    enabled.style.height = '16px';

    const negative = makeInput('checkbox');
    negative.style.width = '16px';
    negative.style.maxWidth = '16px';
    negative.style.height = '16px';

    const dim = makeInput('number');
    dim.step = '1';
    dim.min = '0';

    const bright = makeInput('number');
    bright.step = '1';
    bright.min = '0';

    const alpha = makeInput('number');
    alpha.step = '0.05';
    alpha.min = '0';
    alpha.max = '1';

    const attenuation = makeInput('number');
    attenuation.step = '0.05';
    attenuation.min = '0';
    attenuation.max = '1';

    const luminosity = makeInput('number');
    luminosity.step = '0.05';
    luminosity.min = '0';
    luminosity.max = '1';

    const color = makeInput('color');
    color.style.padding = '0';

    const animType = makeInput('text');
    animType.placeholder = 'torch / pulse / ...';

    const animSpeed = makeInput('number');
    animSpeed.step = '0.5';

    const animIntensity = makeInput('number');
    animIntensity.step = '0.5';

    const cookieEnabled = makeInput('checkbox');
    cookieEnabled.style.width = '16px';
    cookieEnabled.style.maxWidth = '16px';
    cookieEnabled.style.height = '16px';

    const cookieTexture = makeInput('text');
    cookieTexture.placeholder = this._defaultCookieTexture;

    const cookieWrap = _createEl('div', `
      display: flex;
      gap: 6px;
      align-items: center;
      width: 100%;
    `);
    cookieWrap.appendChild(cookieTexture);

    const browseCookie = _createEl('button', `
      height: 24px;
      border-radius: 7px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.9);
      cursor: pointer;
      font-size: 12px;
      padding: 0 8px;
      flex: 0 0 auto;
    `);
    browseCookie.textContent = 'Browse';
    browseCookie.addEventListener('click', async (e) => {
      _stopAndPrevent(e);

      const filePickerImpl = globalThis.foundry?.applications?.apps?.FilePicker?.implementation;
      const FilePickerCls = filePickerImpl ?? globalThis.FilePicker;
      if (!FilePickerCls) {
        ui?.notifications?.warn?.('FilePicker not available');
        return;
      }

      const cur = String(cookieTexture.value || this._defaultCookieTexture || '');
      const fp = new FilePickerCls({
        type: 'image',
        current: cur,
        callback: async (path) => {
          cookieTexture.value = String(path || '').trim();
          this._applyField('cookieTexture', cookieTexture);
        }
      });
      fp.browse();
    });
    cookieWrap.appendChild(browseCookie);

    const cookieRotation = makeInput('number');
    cookieRotation.step = '5';

    const cookieScale = makeInput('number');
    cookieScale.step = '0.1';

    const targetLayers = makeSelect();
    targetLayers.appendChild(new Option('Both', 'both'));
    targetLayers.appendChild(new Option('Ground', 'ground'));
    targetLayers.appendChild(new Option('Overhead', 'overhead'));

    addField('enabled', 'Enabled', enabled);
    addField('negative', 'Darkness', negative);
    addField('dim', 'Dim', dim);
    addField('bright', 'Bright', bright);
    addField('alpha', 'Alpha', alpha);
    addField('attenuation', 'Atten', attenuation);
    addField('luminosity', 'Lum', luminosity);
    addField('color', 'Color', color);
    addField('animType', 'Anim Type', animType);
    addField('animSpeed', 'Anim Speed', animSpeed);
    addField('animIntensity', 'Anim Int', animIntensity);
    addField('cookieEnabled', 'Cookie On', cookieEnabled);
    addField('cookieTexture', 'Cookie', cookieWrap, cookieTexture);
    addField('cookieRotation', 'Cookie Rot', cookieRotation);
    addField('cookieScale', 'Cookie Scale', cookieScale);
    addField('targetLayers', 'Layers', targetLayers);

    details.appendChild(body);

    // Persist changes.
    const onFieldInput = (key) => {
      const el = this.fields.get(key);
      if (!el) return;
      this._applyField(key, el);
    };

    for (const [key, el] of this.fields.entries()) {
      el.addEventListener('input', (e) => {
        _stop(e);
        onFieldInput(key);
      });
      el.addEventListener('change', (e) => {
        _stop(e);
        onFieldInput(key);
      });
    }

    // Wedges:
    // Render visible arc segments per wedge, plus a fill arc for bounded values.
    // Buttons (More/AnimType) live off to the side.

    const wedgeDefs = [
      // Outer ring (ring: 2)
      { ring: 2, id: 'dim', label: 'Radius', start: 0, end: 120, mode: 'vertical', min: 0, max: 400, meter: false },
      { ring: 2, id: 'bright', label: 'Bright', start: 120, end: 240, mode: 'vertical', min: 0, max: 400, meter: false },
      { ring: 2, id: 'color', label: 'Color', start: 240, end: 360, mode: 'tap-color' },

      // Mid ring (ring: 1)
      { ring: 1, id: 'luminosity', label: 'Intensity', start: 0, end: 120, mode: 'vertical', min: 0, max: 1, meter: true },
      { ring: 1, id: 'attenuation', label: 'Falloff', start: 120, end: 240, mode: 'vertical', min: 0, max: 1, meter: true },
      { ring: 1, id: 'alpha', label: 'Alpha', start: 240, end: 360, mode: 'vertical', min: 0, max: 1, meter: true },

      // Inner ring (ring: 0)
      { ring: 0, id: 'animSpeed', label: 'Speed', start: 0, end: 120, mode: 'vertical', min: 0, max: 10 },
      { ring: 0, id: 'animIntensity', label: 'Anim', start: 120, end: 240, mode: 'vertical', min: 0, max: 10 },
      { ring: 0, id: 'enabled', label: 'On', start: 240, end: 360, mode: 'tap-toggle', meter: true },
    ];

    const gapDeg = 12;
    const cx = this._uiCenter;
    const cy = this._uiCenter;

    const makeArcSegmentCircle = (rMid, startDeg, endDeg, stroke, strokeWidth, opacity = 1) => {
      const circ = 2 * Math.PI * rMid;
      const span = Math.max(0.1, endDeg - startDeg);
      const segLen = circ * (span / 360);

      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(cx));
      c.setAttribute('cy', String(cy));
      c.setAttribute('r', String(rMid));
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke', stroke);
      c.setAttribute('stroke-width', String(strokeWidth));
      c.setAttribute('stroke-linecap', 'butt');
      c.setAttribute('stroke-opacity', String(opacity));
      c.setAttribute('stroke-dasharray', `${segLen} ${Math.max(0.1, circ - segLen)}`);

      // Our wedge degrees are 0 at top; SVG dash starts at 3 o'clock.
      // Rotate by (startDeg - 90) so startDeg=0 aligns to top.
      const rot = startDeg - 90;
      c.setAttribute('transform', `rotate(${rot} ${cx} ${cy})`);

      return { c, segLen, circ };
    };

    const makeArcPath = (a0Deg, a1Deg, rOuter, rInner) => {
      const toRad = (d) => (d * Math.PI) / 180;
      const a0 = toRad(a0Deg - 90);
      const a1 = toRad(a1Deg - 90);

      const cx = this._uiCenter;
      const cy = this._uiCenter;

      const p = (a, r) => ({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
      const o0 = p(a0, rOuter);
      const o1 = p(a1, rOuter);
      const i1 = p(a1, rInner);
      const i0 = p(a0, rInner);

      const large = Math.abs(a1Deg - a0Deg) > 180 ? 1 : 0;

      return [
        `M ${o0.x.toFixed(3)} ${o0.y.toFixed(3)}`,
        `A ${rOuter} ${rOuter} 0 ${large} 1 ${o1.x.toFixed(3)} ${o1.y.toFixed(3)}`,
        `L ${i1.x.toFixed(3)} ${i1.y.toFixed(3)}`,
        `A ${rInner} ${rInner} 0 ${large} 0 ${i0.x.toFixed(3)} ${i0.y.toFixed(3)}`,
        'Z'
      ].join(' ');
    };

    for (const w of wedgeDefs) {
      const ring = this._rings[w.ring ?? 1] || this._rings[1];

      // Visible segmented arc for this wedge.
      const rMid = (ring.rInner + ring.rOuter) * 0.5;
      const start = w.start + gapDeg * 0.5;
      const end = w.end - gapDeg * 0.5;

      // Actual wedge background so controls read as wedges (not full rings).
      const wedgeBg = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      wedgeBg.setAttribute('d', makeArcPath(start, end, ring.rOuter, ring.rInner));
      wedgeBg.setAttribute('fill', 'rgba(12, 12, 14, 0.60)');
      wedgeBg.setAttribute('stroke', 'rgba(255,255,255,0.08)');
      wedgeBg.setAttribute('stroke-width', '1');
      wedgeBg.style.pointerEvents = 'none';
      svg.appendChild(wedgeBg);

      // Fill meter (only meaningful for bounded values we explicitly mark).
      if (w.meter === true) {
        const baseArc = makeArcSegmentCircle(rMid, start, end, 'rgba(0,0,0,0)', this._ringThickness, 1);
        const fillArc = makeArcSegmentCircle(rMid, start, end, 'rgba(90, 200, 255, 0.88)', this._ringThickness, 1);
        // Start with empty fill until we have values.
        fillArc.c.setAttribute('stroke-dasharray', `0 ${fillArc.circ}`);
        svg.appendChild(fillArc.c);

        this._meters.set(String(w.id), { fill: fillArc.c, segLen: baseArc.segLen, circ: baseArc.circ });
      }

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', makeArcPath(w.start, w.end, ring.rOuter, ring.rInner));
      path.setAttribute('fill', 'rgba(255,255,255,0.001)');
      path.style.cursor = (String(w.mode || '').startsWith('tap')) ? 'pointer' : 'ns-resize';

      path.addEventListener('pointerdown', (e) => {
        _stopAndPrevent(e);
        if (!this.current) return;

        // Tap wedges.
        if (w.mode === 'tap-toggle') {
          const el = this.fields.get(String(w.id));
          if (el instanceof HTMLInputElement && el.type === 'checkbox') {
            el.checked = !el.checked;
            this._applyField(String(w.id), el);
            this._updateMeter(String(w.id));
          }
          return;
        }

        if (w.mode === 'tap-color') {
          // Ensure details are visible, then focus the color input.
          details.style.display = 'block';
          btnToggle.textContent = 'Hide';
          try {
            const colorEl = this.fields.get('color');
            colorEl?.focus?.();
            colorEl?.click?.();
          } catch (_) {
          }
          return;
        }

        // Custom actions that aren't mapped to numeric input.
        if (w.id === 'details') return;

        const key = w.id;
        const input = this.fields.get(key);
        if (!input) return;

        this._startWedgeDrag(e, w, input);
      });

      svg.appendChild(path);

      // Label ticks (small text) for now.
      const mid = (w.start + w.end) * 0.5;
      const a = ((mid - 90) * Math.PI) / 180;
      const rText = (ring.rInner + ring.rOuter) * 0.5;
      const tx = this._uiCenter + Math.cos(a) * rText;
      const ty = this._uiCenter + Math.sin(a) * rText;
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', tx.toFixed(2));
      t.setAttribute('y', ty.toFixed(2));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dominant-baseline', 'middle');
      t.setAttribute('fill', 'rgba(255,255,255,0.72)');
      t.setAttribute('font-size', '9');
      t.textContent = w.label;
      t.style.pointerEvents = 'none';
      svg.appendChild(t);
    }

    // Side buttons (circular)
    const makeCircleButton = (text) => {
      const b = _createEl('div', `
        width: 30px;
        height: 30px;
        border-radius: 999px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: var(--font-primary, 'Signika', sans-serif);
        font-size: 11px;
        color: rgba(255,255,255,0.92);
        background: rgba(20, 20, 24, 0.88);
        border: 1px solid rgba(255,255,255,0.14);
        box-shadow: 0 8px 18px rgba(0,0,0,0.45);
        cursor: pointer;
        pointer-events: auto;
        user-select: none;
      `);
      b.textContent = text;
      b.addEventListener('pointerdown', _stopAndPrevent, { capture: true });
      return b;
    };

    const btnMoreCircle = makeCircleButton('More');
    btnMoreCircle.style.position = 'absolute';
    btnMoreCircle.style.left = '-38px';
    btnMoreCircle.style.top = `${Math.round(this._uiCenter - 34)}px`;
    btnMoreCircle.addEventListener('click', (e) => {
      _stopAndPrevent(e);
      const isOpen = details.style.display !== 'none';
      details.style.display = isOpen ? 'none' : 'block';
      btnToggle.textContent = isOpen ? 'Show' : 'Hide';
    });

    const btnAnimCircle = makeCircleButton('Anim');
    btnAnimCircle.style.position = 'absolute';
    btnAnimCircle.style.left = '-38px';
    btnAnimCircle.style.top = `${Math.round(this._uiCenter + 6)}px`;
    btnAnimCircle.addEventListener('click', (e) => {
      _stopAndPrevent(e);
      details.style.display = 'block';
      btnToggle.textContent = 'Hide';
      try {
        const animEl = this.fields.get('animType');
        animEl?.focus?.();
        animEl?.click?.();
      } catch (_) {
      }
    });

    ringWrap.appendChild(svg);
    ringWrap.appendChild(label);
    ringWrap.appendChild(details);
    ringWrap.appendChild(btnMoreCircle);
    ringWrap.appendChild(btnAnimCircle);
    container.appendChild(ringWrap);

    this.container = container;
    this._ringWrapEl = ringWrap;
    this.svg = svg;
    this.details = details;
    this._labelEl = label;

    // Global pointer handlers for drag.
    // Use capture phase so we can stop propagation before Foundry/canvas-level handlers.
    window.addEventListener('pointermove', this._boundHandlers.onPointerMove, { passive: false, capture: true });
    window.addEventListener('pointerup', this._boundHandlers.onPointerUp, { passive: false, capture: true });

    this.hide();
    log.info('LightRingUI initialized');
  }

  _updateMeter(key) {
    try {
      const m = this._meters.get(String(key));
      if (!m) return;

      const el = this.fields.get(String(key));
      if (!(el instanceof HTMLInputElement)) return;

      // Only draw meters for numeric/checkbox inputs.
      if (el.type === 'checkbox') {
        const on = el.checked;
        m.fill.setAttribute('stroke-dasharray', `${on ? m.segLen : 0} ${m.circ}`);
        return;
      }

      if (el.type !== 'number') {
        // Non-numeric wedges get no meter.
        m.fill.setAttribute('stroke-dasharray', `0 ${m.circ}`);
        return;
      }

      const w = parseFloat(el.value);
      if (!Number.isFinite(w)) {
        m.fill.setAttribute('stroke-dasharray', `0 ${m.circ}`);
        return;
      }

      // Use the input element's min/max if present.
      const min = Number.isFinite(parseFloat(el.min)) ? parseFloat(el.min) : 0;
      const max = Number.isFinite(parseFloat(el.max)) ? parseFloat(el.max) : 1;
      const denom = Math.max(1e-6, max - min);
      const t = _clamp((w - min) / denom, 0, 1);

      const fillLen = m.segLen * t;
      m.fill.setAttribute('stroke-dasharray', `${fillLen} ${m.circ}`);
    } catch (_) {
    }
  }

  _updateAllMeters() {
    for (const key of this._meters.keys()) {
      this._updateMeter(key);
    }
  }

  /**
   * @param {PointerEvent} e
   * @param {any} wedge
   * @param {HTMLElement} input
   */
  _startWedgeDrag(e, wedge, input) {
    if (!this.current) return;

    this._drag.active = true;
    this._drag.wedge = wedge;
    this._drag.startClientX = e.clientX;
    this._drag.startClientY = e.clientY;
    this._drag.mode = wedge.mode;

    if (input instanceof HTMLInputElement && input.type === 'number') {
      const v = parseFloat(input.value);
      this._drag.startValue = Number.isFinite(v) ? v : 0;
    } else {
      // Non-numeric wedges are not drag targets.
      this._drag.startValue = 0;
    }

    // Save start angle relative to the ring center.
    const rect = (this._ringWrapEl || this.container)?.getBoundingClientRect();
    if (rect) {
      const cx = rect.left + rect.width * 0.5;
      const cy = rect.top + rect.height * 0.5;
      this._drag.startAngle = _polarAngleFromDxDy(e.clientX - cx, e.clientY - cy);

      this._lockOverlayToCurrentCenter();
    } else {
      this._drag.startAngle = 0;
    }

    try {
      (this._ringWrapEl || this.container)?.setPointerCapture?.(e.pointerId);
    } catch (_) {
    }
  }

  _onPointerMove(e) {
    if (!this._drag.active || !this.current) return;

    _stopAndPrevent(e);

    const wedge = this._drag.wedge;
    if (!wedge) return;

    const key = wedge.id;
    const input = this.fields.get(key);
    if (!(input instanceof HTMLInputElement)) return;

    const fine = e.altKey;
    const coarse = e.shiftKey;

    if (wedge.mode === 'vertical') {
      const dy = e.clientY - this._drag.startClientY;
      const speed = fine ? 0.0025 : (coarse ? 0.02 : 0.01);
      const delta = -dy * speed;

      const min = _isFiniteNumber(wedge.min) ? wedge.min : 0;
      const max = _isFiniteNumber(wedge.max) ? wedge.max : 1;

      let v = this._drag.startValue;
      // For dim (in scene units), scale delta more.
      if (key === 'dim') {
        v = v + delta * 150;
      } else if (key === 'animIntensity') {
        v = v + delta * 20;
      } else {
        v = v + delta;
      }

      v = _clamp(v, min, max);
      input.value = String(Math.round(v * 1000) / 1000);

      this._applyField(key, input, { allowThrottle: true });
      this._updateMeter(key);
      this._labelEl.textContent = `${wedge.label}: ${input.value}`;
      return;
    }

    // Future: angle-based drag for hue/radius.
  }

  _onPointerUp(e) {
    // Always release any overlay lock on pointer up, even if the interaction
    // was a details-panel slider/input rather than a wedge drag.
    if (this._overlayLocked) {
      try {
        this.overlayManager?.unlockOverlay?.('light-ring');
      } catch (_) {
      }
      this._overlayLocked = false;
    }

    if (!this._drag.active) return;
    _stopAndPrevent(e);

    this._drag.active = false;
    this._drag.wedge = null;
    this._drag.mode = null;
    this._labelEl.textContent = '';
  }

  _lockOverlayToCurrentCenter() {
    if (this._overlayLocked) return;

    try {
      const rect = (this._ringWrapEl || this.container)?.getBoundingClientRect();
      if (!rect) return;
      const cx = rect.left + rect.width * 0.5;
      const cy = rect.top + rect.height * 0.5;
      this.overlayManager?.lockOverlay?.('light-ring', { x: cx, y: cy });
      this._overlayLocked = true;
    } catch (_) {
    }
  }

  /**
   * @param {string} key
   * @param {HTMLElement} el
   * @param {{allowThrottle?: boolean}} [opts]
   */
  async _applyField(key, el, opts = undefined) {
    if (!this.current) return;

    const allowThrottle = opts?.allowThrottle === true;

    // Throttle during drags to avoid spamming document updates.
    if (allowThrottle) {
      const now = performance.now();
      if (now - this._lastAppliedAt < 60) return;
      this._lastAppliedAt = now;
    }

    try {
      if (this.current.type === 'enhanced') {
        const api = window.MapShine?.enhancedLights;
        if (!api) return;
        const id = this.current.id;

        const update = {};

        if (key === 'enabled') {
          update.enabled = !!(el instanceof HTMLInputElement ? el.checked : false);
        } else if (key === 'negative') {
          update.isDarkness = !!(el instanceof HTMLInputElement ? el.checked : false);
        } else if (key === 'color') {
          update.color = String(el instanceof HTMLInputElement ? el.value : '#ffffff');
        } else if (key === 'targetLayers') {
          update.targetLayers = String(el instanceof HTMLSelectElement ? el.value : 'both');
        } else if (key === 'cookieEnabled') {
          update.cookieEnabled = !!(el instanceof HTMLInputElement ? el.checked : false);
        } else if (key === 'cookieTexture') {
          const v = String(el.value || '').trim();
          update.cookieTexture = v || this._defaultCookieTexture;
        } else if (key === 'cookieRotation') {
          const v = parseFloat(el.value);
          if (Number.isFinite(v)) update.cookieRotation = v;
        } else if (key === 'cookieScale') {
          const v = parseFloat(el.value);
          if (Number.isFinite(v)) update.cookieScale = v;
        } else if (key === 'animType' || key === 'animSpeed' || key === 'animIntensity') {
          const cur = await api.get(id);
          const a0 = (cur && typeof cur.animation === 'object') ? cur.animation : {};
          const a = { ...a0 };
          if (key === 'animType') a.type = String(el.value || '').trim() || null;
          if (key === 'animSpeed') {
            const v = parseFloat(el.value);
            if (Number.isFinite(v)) a.speed = v;
          }
          if (key === 'animIntensity') {
            const v = parseFloat(el.value);
            if (Number.isFinite(v)) a.intensity = v;
          }
          update.animation = a;
        } else if (['dim', 'bright', 'alpha', 'attenuation', 'luminosity'].includes(key)) {
          const v = parseFloat(el.value);
          if (!Number.isFinite(v)) return;
          update.photometry = { [key]: v };
        }

        await api.update(id, update);
        return;
      }

      if (this.current.type === 'foundry') {
        const doc = canvas?.scene?.lights?.get?.(this.current.id) || canvas?.lighting?.get?.(this.current.id)?.document;
        if (!doc) return;

        const update = {};

        if (key === 'enabled') {
          update.hidden = !(el instanceof HTMLInputElement ? el.checked : true);
        } else if (key === 'negative') {
          update.negative = !!(el instanceof HTMLInputElement ? el.checked : false);
        } else if (key === 'color') {
          update.config = { color: String(el.value || '#ffffff') };
        } else if (key === 'targetLayers') {
          // No direct Foundry equivalent.
        } else if (key === 'cookieTexture' || key === 'cookieRotation' || key === 'cookieScale') {
          // Not supported by Foundry base lights; ignore.
        } else if (key === 'animType' || key === 'animSpeed' || key === 'animIntensity') {
          const curAnim = doc.config?.animation ?? {};
          const next = { ...curAnim };
          if (key === 'animType') next.type = String(el.value || '').trim() || null;
          if (key === 'animSpeed') {
            const v = parseFloat(el.value);
            if (Number.isFinite(v)) next.speed = v;
          }
          if (key === 'animIntensity') {
            const v = parseFloat(el.value);
            if (Number.isFinite(v)) next.intensity = v;
          }
          update.config = { animation: next };
        } else if (['dim', 'bright', 'alpha', 'attenuation', 'luminosity'].includes(key)) {
          const v = parseFloat(el.value);
          if (!Number.isFinite(v)) return;
          update.config = { [key]: v };
        }

        await doc.update(update);
      }
    } catch (err) {
      // Avoid noisy notifications while dragging.
      log.debug('apply field failed', err);
    }
  }

  /**
   * @param {{type:'foundry'|'enhanced', id:string}} selection
   * @param {THREE.Object3D|null} anchorObject
   */
  async show(selection, anchorObject) {
    this.initialize();

    this.current = selection;
    this._anchorObject = anchorObject || null;

    this.overlayManager.setVisible('light-ring', true);

    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? this.overlayManager?.sceneComposer?.groundZ ?? 0;
    // Keep the UI anchored very close to the ground plane to avoid perspective parallax.
    const anchorZ = groundZ + 0.01;
    if (this.current.type === 'foundry') {
      // Anchor Foundry lights to a stable world position (doc.x/doc.y) rather than the
      // transient icon sprite, which can be recreated during updates and cause UI jumps.
      try {
        const doc = canvas?.scene?.lights?.get?.(this.current.id) || canvas?.lighting?.get?.(this.current.id)?.document;
        if (doc) {
          const THREE = window.THREE;
          if (THREE) {
            if (!this._tmpAnchorWorld) this._tmpAnchorWorld = new THREE.Vector3();
            const w = Coordinates.toWorld(doc.x, doc.y);
            w.z = anchorZ;
            this._tmpAnchorWorld.copy(w);
            this.overlayManager.setAnchorWorld('light-ring', this._tmpAnchorWorld);
          }
        }
      } catch (_) {
      }
    } else {
      // Enhanced lights: anchor to the entity's stable Foundry/world position rather than
      // the transient gizmo Object3D. The gizmo can be recreated when scene flags update,
      // which causes a one-time overlay "jump" and parallax offset.
      let anchored = false;
      try {
        const api = window.MapShine?.enhancedLights;
        if (api) {
          const data = await api.get(this.current.id);
          const x = data?.transform?.x;
          const y = data?.transform?.y;
          if (Number.isFinite(x) && Number.isFinite(y)) {
            const THREE = window.THREE;
            if (THREE) {
              if (!this._tmpAnchorWorld) this._tmpAnchorWorld = new THREE.Vector3();
              const w = Coordinates.toWorld(x, y);
              w.z = anchorZ;
              this._tmpAnchorWorld.copy(w);
              this.overlayManager.setAnchorWorld('light-ring', this._tmpAnchorWorld);
              anchored = true;
            }
          }
        }
      } catch (_) {
      }

      if (!anchored) {
        this.overlayManager.setAnchorObject('light-ring', this._anchorObject);
      }
    }

    try {
      if (this.details) this.details.style.display = 'none';
    } catch (_) {
    }

    await this._refreshFromSource();
  }

  hide() {
    this.current = null;
    this._anchorObject = null;

    try {
      if (this.details) this.details.style.display = 'none';
      if (this._labelEl) this._labelEl.textContent = '';
    } catch (_) {
    }

    this.overlayManager.setVisible('light-ring', false);
    this.overlayManager.setAnchorObject('light-ring', null);
    this.overlayManager.setAnchorWorld('light-ring', null);

    if (this._overlayLocked) {
      try {
        this.overlayManager?.unlockOverlay?.('light-ring');
      } catch (_) {
      }
      this._overlayLocked = false;
    }

    // Keep DOM refs for reuse, but drop transient drag state.
    this._drag.active = false;
    this._drag.wedge = null;
    this._drag.mode = null;
  }

  dispose() {
    try {
      this.hide();
    } catch (_) {
    }

    try {
      window.removeEventListener('pointermove', this._boundHandlers.onPointerMove, { passive: false, capture: true });
      window.removeEventListener('pointerup', this._boundHandlers.onPointerUp, { passive: false, capture: true });
    } catch (_) {
    }
    // Some browsers ignore options matching; fallback to no-options remove.
    try {
      window.removeEventListener('pointermove', this._boundHandlers.onPointerMove);
      window.removeEventListener('pointerup', this._boundHandlers.onPointerUp);
    } catch (_) {
    }

    this.fields.clear();
    this.container = null;
    this.svg = null;
    this.details = null;
    this._labelEl = null;
  }

  async _refreshFromSource() {
    if (!this.current) return;

    try {
      if (this.current.type === 'enhanced') {
        const api = window.MapShine?.enhancedLights;
        if (!api) return;

        const data = await api.get(this.current.id);
        if (!data) return;

        const enabled = data.enabled !== false;
        const isDarkness = data.isDarkness === true;
        const phot = data.photometry || {};
        const anim = data.animation || {};

        this._setField('enabled', enabled);
        this._setField('negative', isDarkness);
        this._setField('dim', phot.dim ?? 0);
        this._setField('bright', phot.bright ?? 0);
        this._setField('alpha', phot.alpha ?? 0.5);
        this._setField('attenuation', phot.attenuation ?? 0.5);
        this._setField('luminosity', phot.luminosity ?? 0.5);
        this._setField('color', data.color ?? '#ffffff');
        this._setField('animType', anim.type ?? '');
        this._setField('animSpeed', anim.speed ?? 5);
        this._setField('animIntensity', anim.intensity ?? 5);
        this._setField('cookieEnabled', data.cookieEnabled === true);
        this._setField('cookieTexture', data.cookieTexture ?? this._defaultCookieTexture);
        this._setField('cookieRotation', data.cookieRotation ?? 0);
        this._setField('cookieScale', data.cookieScale ?? 1);
        this._setField('targetLayers', data.targetLayers ?? 'both');

        this._updateAllMeters();

        return;
      }

      if (this.current.type === 'foundry') {
        const doc = canvas?.scene?.lights?.get?.(this.current.id) || canvas?.lighting?.get?.(this.current.id)?.document;
        if (!doc) return;

        const cfg = doc.config || {};
        const anim = cfg.animation || {};

        // Foundry uses `hidden` to disable.
        const enabled = doc.hidden !== true;
        const negative = (cfg.negative === true) || (doc.negative === true);

        this._setField('enabled', enabled);
        this._setField('negative', negative);
        this._setField('dim', cfg.dim ?? 0);
        this._setField('bright', cfg.bright ?? 0);
        this._setField('alpha', cfg.alpha ?? 0.5);
        this._setField('attenuation', cfg.attenuation ?? 0.5);
        this._setField('luminosity', cfg.luminosity ?? 0.5);

        // config.color can be null; normalize.
        let c = cfg.color;
        if (typeof c === 'number') {
          const r = ((c >> 16) & 255) / 255;
          const g = ((c >> 8) & 255) / 255;
          const b = (c & 255) / 255;
          c = _rgbToHex({ r, g, b });
        }
        this._setField('color', typeof c === 'string' ? c : '#ffffff');

        this._setField('animType', anim.type ?? '');
        this._setField('animSpeed', anim.speed ?? 5);
        this._setField('animIntensity', anim.intensity ?? 5);

        // Not supported for Foundry lights.
        this._setField('cookieTexture', '');
        this._setField('cookieRotation', 0);
        this._setField('cookieScale', 1);
        this._setField('targetLayers', 'both');

        this._updateAllMeters();
      }
    } catch (err) {
      log.debug('refresh failed', err);
    }
  }

  _setField(key, value) {
    const el = this.fields.get(key);
    if (!el) return;

    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox') {
        el.checked = !!value;
      } else if (el.type === 'color') {
        el.value = String(value || '#ffffff');
      } else {
        el.value = String(value ?? '');
      }
      return;
    }

    if (el instanceof HTMLSelectElement) {
      el.value = String(value ?? '');
    }

    this._updateMeter(key);
  }

  /**
   * Called per-frame by EffectComposer.
   */
  update(_timeInfo) {
    // Keep the anchor stable for Foundry lights even if the icon sprite is recreated.
    if (!this.current) return;
    if (this.current.type !== 'foundry') return;

    try {
      const doc = canvas?.scene?.lights?.get?.(this.current.id) || canvas?.lighting?.get?.(this.current.id)?.document;
      if (!doc) return;
      const THREE = window.THREE;
      if (!THREE) return;
      if (!this._tmpAnchorWorld) this._tmpAnchorWorld = new THREE.Vector3();

      const groundZ = window.MapShine?.sceneComposer?.groundZ ?? this.overlayManager?.sceneComposer?.groundZ ?? 0;
      const anchorZ = groundZ + 0.01;

      const w = Coordinates.toWorld(doc.x, doc.y);
      w.z = anchorZ;
      this._tmpAnchorWorld.copy(w);
      this.overlayManager.setAnchorWorld('light-ring', this._tmpAnchorWorld);
    } catch (_) {
    }
  }

  /**
   * @returns {boolean}
   */
  isVisible() {
    return !!this.current;
  }
}
