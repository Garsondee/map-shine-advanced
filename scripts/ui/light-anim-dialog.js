/**
 * @fileoverview LightAnimDialog
 * Dedicated animation authoring dialog for lights, opened from LightRingUI.
 *
 * This is intentionally lightweight (no frameworks) and uses OverlayUIManager
 * so it can be anchored near the selected light while remaining screen-legible.
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';

const log = createLogger('LightAnimDialog');

function _isObject(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function _stopOnly(e) {
  try {
    e.stopPropagation();
  } catch (_) {
  }

  try {
    e.stopImmediatePropagation?.();
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

function _clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export class LightAnimDialog {
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

    /** @type {Map<string, HTMLElement>} */
    this.fields = new Map();

    // Reuse a vector for stable anchoring.
    this._tmpAnchorWorld = null;

    // UI constants
    this._panelWidth = 520;

    // Guard against recursive input loops.
    this._suppressInput = false;
  }

  initialize() {
    if (this.container) return;

    const h = this.overlayManager.createOverlay('light-anim', {
      capturePointerEvents: true,
      clampToScreen: true,
      offsetPx: { x: 280, y: 0 },
      marginPx: 24,
    });

    const container = h.el;
    container.id = 'map-shine-light-anim-dialog';
    container.classList.add('map-shine-overlay-ui');
    container.style.pointerEvents = 'auto';
    container.style.userSelect = 'none';
    container.style.webkitUserSelect = 'none';

    // Keep overlay handle stable.
    container.style.width = '0px';
    container.style.height = '0px';

    // Prevent interactions from reaching the canvas.
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
      container.addEventListener(type, (e) => {
        try {
          const t = e?.target;
          const isFormControl = (t instanceof Element)
            ? !!t.closest('button, a, input, select, textarea, label, summary')
            : false;

          // Only swallow events that would otherwise pan/drag the canvas.
          // IMPORTANT: do not interfere with form controls (like the dialog close button).
          if (!isFormControl) {
            try {
              e.preventDefault();
            } catch (_) {
            }

            try {
              e.stopPropagation();
              e.stopImmediatePropagation?.();
            } catch (_) {
            }
          }
        } catch (_) {
        }
      }, { capture: true });
    }

    const panel = document.createElement('div');
    panel.style.cssText = `
      position: absolute;
      left: 0px;
      top: 0px;
      transform: translate(-50%, -50%);
      width: ${this._panelWidth}px;
      padding: 12px 12px;
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

    panel.addEventListener('contextmenu', _stopAndPrevent);

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    `;

    const title = document.createElement('div');
    title.style.cssText = `
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 0.2px;
      color: rgba(80, 200, 255, 0.95);
    `;
    title.textContent = 'Anim';

    const headerRight = document.createElement('div');
    headerRight.style.cssText = `display:flex; align-items:center; gap:6px;`;

    const preset = document.createElement('select');
    preset.style.cssText = `
      height: 24px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.9);
      padding: 0 6px;
      font-size: 12px;
    `;
    preset.appendChild(new Option('Custom', 'custom'));
    preset.appendChild(new Option('Torch', 'torch'));
    preset.appendChild(new Option('Candle', 'candle'));
    preset.appendChild(new Option('Neon', 'neon'));
    preset.appendChild(new Option('Alarm', 'alarm'));
    preset.appendChild(new Option('Window Beam', 'window'));
    preset.appendChild(new Option('Cable Swing', 'cableswing'));
    preset.appendChild(new Option('Sun Light', 'sun'));

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

    headerRight.appendChild(preset);
    headerRight.appendChild(btnClose);

    header.appendChild(title);
    header.appendChild(headerRight);

    const body = document.createElement('div');
    body.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 560px;
      overflow: auto;
      padding-right: 6px;
    `;

    const makeInput = (type) => {
      const input = /** @type {HTMLInputElement} */(document.createElement('input'));
      input.type = type;
      input.style.width = '100%';
      input.style.maxWidth = '100%';
      input.style.height = '24px';
      input.style.borderRadius = '8px';
      input.style.border = '1px solid rgba(255,255,255,0.14)';
      input.style.background = 'rgba(255,255,255,0.06)';
      input.style.color = 'rgba(255,255,255,0.9)';
      input.style.padding = '0 8px';
      input.style.fontSize = '12px';
      return input;
    };

    const makeCheckbox = () => {
      const input = makeInput('checkbox');
      input.style.width = '18px';
      input.style.maxWidth = '18px';
      input.style.height = '18px';
      input.style.margin = '0';
      input.style.padding = '0';
      input.style.borderRadius = '0';
      input.style.border = 'none';
      input.style.background = 'transparent';
      input.style.appearance = 'auto';
      input.style.webkitAppearance = 'auto';
      input.style.flex = '0 0 auto';
      return input;
    };

    const addRow = (labelText, inputEl) => {
      const row = document.createElement('div');
      row.style.cssText = `
        display: grid;
        grid-template-columns: 160px 1fr;
        gap: 10px;
        align-items: center;
      `;

      const label = document.createElement('div');
      label.textContent = labelText;
      label.style.cssText = `
        font-size: 12px;
        opacity: 0.90;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      `;

      row.appendChild(label);
      row.appendChild(inputEl);
      return row;
    };

    const addSection = (sectionTitle) => {
      const d = document.createElement('details');
      d.open = sectionTitle === 'Global';
      d.style.cssText = `
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 10px;
        padding: 8px 10px;
        background: rgba(0,0,0,0.10);
      `;

      const s = document.createElement('summary');
      s.textContent = sectionTitle;
      s.style.cssText = `
        cursor: pointer;
        font-weight: 700;
        font-size: 12px;
        color: rgba(255,255,255,0.88);
        outline: none;
      `;
      // IMPORTANT: do not preventDefault here, or <details> will not toggle.
      // We only stop propagation to keep clicks from reaching the canvas.
      s.addEventListener('pointerdown', _stopOnly, { capture: true });
      s.addEventListener('click', _stopOnly, { capture: true });

      const inner = document.createElement('div');
      inner.style.cssText = `
        margin-top: 8px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      `;

      d.appendChild(s);
      d.appendChild(inner);
      body.appendChild(d);
      return inner;
    };

    // ---- Fields ----

    const global = addSection('Global');

    const animType = makeInput('text');
    animType.placeholder = 'torch / pulse / ...';

    const animSpeed = makeInput('number');
    animSpeed.step = '0.1';

    const animIntensity = makeInput('number');
    animIntensity.step = '0.1';

    const animReverse = makeCheckbox();

    const seed = makeInput('number');
    seed.step = '1';

    global.appendChild(addRow('Type', animType));
    global.appendChild(addRow('Speed', animSpeed));
    global.appendChild(addRow('Intensity', animIntensity));
    global.appendChild(addRow('Reverse', animReverse));
    global.appendChild(addRow('Seed', seed));

    const motion = addSection('Motion');

    const motionMaxOffsetPx = makeInput('number');
    motionMaxOffsetPx.step = '1';

    const motionSpring = makeInput('number');
    motionSpring.step = '0.1';

    const motionDamping = makeInput('number');
    motionDamping.step = '0.1';

    const motionWindInfluence = makeInput('number');
    motionWindInfluence.step = '0.05';

    const motionResponsiveness = makeInput('number');
    motionResponsiveness.step = '0.1';

    motion.appendChild(addRow('Max Offset (px)', motionMaxOffsetPx));
    motion.appendChild(addRow('Spring', motionSpring));
    motion.appendChild(addRow('Damping', motionDamping));
    motion.appendChild(addRow('Wind Influence', motionWindInfluence));
    motion.appendChild(addRow('Responsiveness', motionResponsiveness));

    const sun = addSection('Sun (Darkness Driven)');

    const sunEnabled = makeCheckbox();
    const sunInvert = makeCheckbox();

    const sunExponent = makeInput('number');
    sunExponent.step = '0.1';

    const sunMin = makeInput('number');
    sunMin.step = '0.05';

    const sunMax = makeInput('number');
    sunMax.step = '0.05';

    sun.appendChild(addRow('Enabled', sunEnabled));
    sun.appendChild(addRow('Invert (day=1)', sunInvert));
    sun.appendChild(addRow('Exponent', sunExponent));
    sun.appendChild(addRow('Min', sunMin));
    sun.appendChild(addRow('Max', sunMax));

    // Store
    this.fields.set('preset', preset);
    this.fields.set('animType', animType);
    this.fields.set('animSpeed', animSpeed);
    this.fields.set('animIntensity', animIntensity);
    this.fields.set('animReverse', animReverse);
    this.fields.set('seed', seed);

    this.fields.set('motionMaxOffsetPx', motionMaxOffsetPx);
    this.fields.set('motionSpring', motionSpring);
    this.fields.set('motionDamping', motionDamping);
    this.fields.set('motionWindInfluence', motionWindInfluence);
    this.fields.set('motionResponsiveness', motionResponsiveness);

    this.fields.set('sunEnabled', sunEnabled);
    this.fields.set('sunInvert', sunInvert);
    this.fields.set('sunExponent', sunExponent);
    this.fields.set('sunMin', sunMin);
    this.fields.set('sunMax', sunMax);

    // Persist changes
    const onFieldInput = (key) => {
      if (this._suppressInput) return;
      const el = this.fields.get(key);
      if (!el) return;
      this._applyField(key, el);
    };

    for (const [key, el] of this.fields.entries()) {
      if (key === 'preset') {
        el.addEventListener('change', (e) => {
          _stopAndPrevent(e);
          this._applyPreset(String(/** @type {HTMLSelectElement} */(el).value || 'custom'));
        });
        continue;
      }

      el.addEventListener('input', (e) => {
        try {
          e.stopPropagation();
        } catch (_) {
        }
        onFieldInput(key);
      });
      el.addEventListener('change', (e) => {
        try {
          e.stopPropagation();
        } catch (_) {
        }
        onFieldInput(key);
      });
    }

    panel.appendChild(header);
    panel.appendChild(body);
    container.appendChild(panel);

    this.container = container;
    this._panel = panel;

    this.hide();
    log.info('LightAnimDialog initialized');
  }

  hide() {
    this.current = null;
    this._anchorObject = null;

    try {
      if (this._panel) this._panel.style.display = 'none';
    } catch (_) {
    }

    this.overlayManager.setVisible('light-anim', false);
    this.overlayManager.setAnchorObject('light-anim', null);
    this.overlayManager.setAnchorWorld('light-anim', null);
  }

  /**
   * @param {{type:'foundry'|'enhanced', id:string}} selection
   * @param {THREE.Object3D|null} anchorObject
   */
  async show(selection, anchorObject) {
    this.initialize();

    this.current = selection;
    this._anchorObject = anchorObject || null;

    this.overlayManager.setVisible('light-anim', true);

    // Anchor similarly to LightRingUI: prefer stable doc coords.
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? this.overlayManager?.sceneComposer?.groundZ ?? 0;
    const anchorZ = groundZ + 0.01;

    if (this.current.type === 'foundry') {
      try {
        const doc = canvas?.scene?.lights?.get?.(this.current.id) || canvas?.lighting?.get?.(this.current.id)?.document;
        if (doc && window.THREE) {
          if (!this._tmpAnchorWorld) this._tmpAnchorWorld = new window.THREE.Vector3();
          const w = Coordinates.toWorld(doc.x, doc.y);
          w.z = anchorZ;
          this._tmpAnchorWorld.copy(w);
          this.overlayManager.setAnchorWorld('light-anim', this._tmpAnchorWorld);
        }
      } catch (_) {
      }
    } else {
      let anchored = false;
      try {
        const api = window.MapShine?.enhancedLights;
        if (api && window.THREE) {
          const data = await api.get(this.current.id);
          const x = data?.transform?.x;
          const y = data?.transform?.y;
          if (Number.isFinite(x) && Number.isFinite(y)) {
            if (!this._tmpAnchorWorld) this._tmpAnchorWorld = new window.THREE.Vector3();
            const w = Coordinates.toWorld(x, y);
            w.z = anchorZ;
            this._tmpAnchorWorld.copy(w);
            this.overlayManager.setAnchorWorld('light-anim', this._tmpAnchorWorld);
            anchored = true;
          }
        }
      } catch (_) {
      }

      if (!anchored) {
        this.overlayManager.setAnchorObject('light-anim', this._anchorObject);
      }
    }

    try {
      if (this._panel) this._panel.style.display = 'block';
    } catch (_) {
    }

    await this._refreshFromSource();
  }

  async _refreshFromSource() {
    if (!this.current) return;

    this._suppressInput = true;

    try {
      // Reset preset selector to custom by default.
      const preset = this.fields.get('preset');
      if (preset instanceof HTMLSelectElement) preset.value = 'custom';

      if (this.current.type === 'enhanced') {
        const api = window.MapShine?.enhancedLights;
        if (!api) return;

        const data = await api.get(this.current.id);
        if (!data) return;

        const anim = _isObject(data.animation) ? data.animation : {};
        const sun = _isObject(data.darknessResponse) ? data.darknessResponse : {};

        this._setField('animType', anim.type ?? '');
        this._setField('animSpeed', anim.speed ?? 5);
        this._setField('animIntensity', anim.intensity ?? 5);
        this._setField('animReverse', anim.reverse === true);
        this._setField('seed', Number.isFinite(anim.seed) ? anim.seed : (Number.isFinite(data.seed) ? data.seed : 0));

        this._setField('motionMaxOffsetPx', Number.isFinite(anim.motionMaxOffsetPx) ? anim.motionMaxOffsetPx : 120);
        this._setField('motionSpring', Number.isFinite(anim.motionSpring) ? anim.motionSpring : 12.0);
        this._setField('motionDamping', Number.isFinite(anim.motionDamping) ? anim.motionDamping : 4.0);
        this._setField('motionWindInfluence', Number.isFinite(anim.motionWindInfluence) ? anim.motionWindInfluence : 1.0);
        this._setField('motionResponsiveness', Number.isFinite(anim.motionResponsiveness) ? anim.motionResponsiveness : (Number.isFinite(anim.speed) ? anim.speed : 5));

        this._setField('sunEnabled', sun.enabled === true);
        this._setField('sunInvert', sun.invert !== false);
        this._setField('sunExponent', Number.isFinite(sun.exponent) ? sun.exponent : 1.0);
        this._setField('sunMin', Number.isFinite(sun.min) ? sun.min : 0.0);
        this._setField('sunMax', Number.isFinite(sun.max) ? sun.max : 1.0);
        return;
      }

      if (this.current.type === 'foundry') {
        const doc = canvas?.scene?.lights?.get?.(this.current.id) || canvas?.lighting?.get?.(this.current.id)?.document;
        if (!doc) return;

        const cfg = doc.config || {};
        const anim = cfg.animation || {};

        this._setField('animType', anim.type ?? '');
        this._setField('animSpeed', anim.speed ?? 5);
        this._setField('animIntensity', anim.intensity ?? 5);
        this._setField('animReverse', anim.reverse === true);
        this._setField('seed', 0);

        // Sun controls are MapShine-only.
        this._setField('sunEnabled', false);
        this._setField('sunInvert', true);
        this._setField('sunExponent', 1.0);
        this._setField('sunMin', 0.0);
        this._setField('sunMax', 1.0);

        // Motion controls are MapShine-only.
        this._setField('motionMaxOffsetPx', 120);
        this._setField('motionSpring', 12.0);
        this._setField('motionDamping', 4.0);
        this._setField('motionWindInfluence', 1.0);
        this._setField('motionResponsiveness', 5);
      }
    } catch (err) {
      log.debug('refresh failed', err);
    } finally {
      this._suppressInput = false;
    }
  }

  _setField(key, value) {
    const el = this.fields.get(key);
    if (!el) return;

    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox') {
        el.checked = !!value;
      } else {
        el.value = String(value ?? '');
      }
      return;
    }

    if (el instanceof HTMLSelectElement) {
      el.value = String(value ?? '');
    }
  }

  async _applyPreset(presetId) {
    if (!this.current) return;

    // Presets are applied only to MapShine enhanced lights for now.
    if (this.current.type !== 'enhanced') return;

    const api = window.MapShine?.enhancedLights;
    if (!api) return;

    const update = {};

    // Ensure presets are mutually exclusive with Sun Light.
    // If the light was previously configured as a Sun Light (darkness-driven),
    // switching to any other preset must clear that state so the renderer stops
    // routing it to the sun-light buffer.
    if (presetId !== 'sun') {
      update.darknessResponse = { enabled: false };
    }

    if (presetId === 'torch') {
      update.animation = { type: 'torch', speed: 5, intensity: 5 };
    } else if (presetId === 'candle') {
      update.animation = { type: 'flame', speed: 3, intensity: 3 };
    } else if (presetId === 'neon') {
      update.animation = { type: 'pulse', speed: 1.5, intensity: 2.0 };
    } else if (presetId === 'alarm') {
      update.animation = { type: 'siren', speed: 6, intensity: 7 };
    } else if (presetId === 'window') {
      update.animation = { type: 'wave', speed: 0.6, intensity: 2.0 };
    } else if (presetId === 'cableswing') {
      update.animation = {
        type: 'cableswing',
        speed: 5,
        intensity: 7,
        motionMaxOffsetPx: 140,
        motionSpring: 12.0,
        motionDamping: 4.0,
        motionWindInfluence: 1.0,
        motionResponsiveness: 5.0,
      };
    } else if (presetId === 'sun') {
      update.darknessResponse = {
        enabled: true,
        invert: true,
        exponent: 1.0,
        min: 0.0,
        max: 1.0
      };
    } else {
      return;
    }

    try {
      await api.update(this.current.id, update);
      await this._refreshFromSource();
    } catch (err) {
      log.debug('apply preset failed', err);
    }
  }

  /**
   * @param {string} key
   * @param {HTMLElement} el
   */
  async _applyField(key, el) {
    if (!this.current) return;

    try {
      if (this.current.type === 'enhanced') {
        const api = window.MapShine?.enhancedLights;
        if (!api) return;

        const id = this.current.id;
        const cur = await api.get(id);

        const update = {};

        // Animation fields (stored on enhanced light as-is; renderer consumes a subset for now).
        if (key === 'animType' || key === 'animSpeed' || key === 'animIntensity' || key === 'animReverse' || key === 'seed'
          || key === 'motionMaxOffsetPx' || key === 'motionSpring' || key === 'motionDamping' || key === 'motionWindInfluence' || key === 'motionResponsiveness') {
          const a0 = _isObject(cur?.animation) ? cur.animation : {};
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
          if (key === 'animReverse') a.reverse = (el instanceof HTMLInputElement) ? el.checked : false;
          if (key === 'seed') {
            const v = Math.floor(Number(el.value) || 0);
            if (Number.isFinite(v)) a.seed = v;
          }

          if (key === 'motionMaxOffsetPx') {
            const v = parseFloat(el.value);
            if (Number.isFinite(v)) a.motionMaxOffsetPx = v;
          }
          if (key === 'motionSpring') {
            const v = parseFloat(el.value);
            if (Number.isFinite(v)) a.motionSpring = v;
          }
          if (key === 'motionDamping') {
            const v = parseFloat(el.value);
            if (Number.isFinite(v)) a.motionDamping = v;
          }
          if (key === 'motionWindInfluence') {
            const v = parseFloat(el.value);
            if (Number.isFinite(v)) a.motionWindInfluence = v;
          }
          if (key === 'motionResponsiveness') {
            const v = parseFloat(el.value);
            if (Number.isFinite(v)) a.motionResponsiveness = v;
          }

          update.animation = a;
          await api.update(id, update);
          return;
        }

        // Sun/darkness-driven response.
        if (key.startsWith('sun')) {
          const s0 = _isObject(cur?.darknessResponse) ? cur.darknessResponse : {};
          const s = { ...s0 };

          if (key === 'sunEnabled') s.enabled = (el instanceof HTMLInputElement) ? el.checked : false;
          if (key === 'sunInvert') s.invert = (el instanceof HTMLInputElement) ? el.checked : false;
          if (key === 'sunExponent') {
            const v = parseFloat(el.value);
            if (Number.isFinite(v)) s.exponent = v;
          }
          if (key === 'sunMin') {
            const v = parseFloat(el.value);
            if (Number.isFinite(v)) s.min = v;
          }
          if (key === 'sunMax') {
            const v = parseFloat(el.value);
            if (Number.isFinite(v)) s.max = v;
          }

          // Clamp for safety.
          if (s.min !== undefined) s.min = _clamp01(s.min);
          if (s.max !== undefined) s.max = _clamp01(s.max);

          update.darknessResponse = s;
          await api.update(id, update);
          return;
        }

        return;
      }

      if (this.current.type === 'foundry') {
        const doc = canvas?.scene?.lights?.get?.(this.current.id) || canvas?.lighting?.get?.(this.current.id)?.document;
        if (!doc) return;

        // Foundry only supports animation.*; other fields are MapShine-only.
        if (key === 'animType' || key === 'animSpeed' || key === 'animIntensity' || key === 'animReverse') {
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
          if (key === 'animReverse') next.reverse = (el instanceof HTMLInputElement) ? el.checked : false;

          await doc.update({ config: { animation: next } });
        }
      }
    } catch (err) {
      log.debug('apply field failed', err);
    }
  }

  update(_timeInfo) {
    // Keep anchor stable for Foundry lights even if icon sprites are recreated.
    if (!this.current) return;

    if (this.current.type !== 'foundry') return;

    try {
      const doc = canvas?.scene?.lights?.get?.(this.current.id) || canvas?.lighting?.get?.(this.current.id)?.document;
      if (!doc) return;
      if (!window.THREE) return;
      if (!this._tmpAnchorWorld) this._tmpAnchorWorld = new window.THREE.Vector3();

      const groundZ = window.MapShine?.sceneComposer?.groundZ ?? this.overlayManager?.sceneComposer?.groundZ ?? 0;
      const anchorZ = groundZ + 0.01;

      const w = Coordinates.toWorld(doc.x, doc.y);
      w.z = anchorZ;
      this._tmpAnchorWorld.copy(w);
      this.overlayManager.setAnchorWorld('light-anim', this._tmpAnchorWorld);
    } catch (_) {
    }
  }
}
