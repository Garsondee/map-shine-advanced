/**
 * @fileoverview PAINT MODE — the generic DOM widgets. Small, self-contained
 * control builders (styled inputs, buttons, ranges, segmented switches, the
 * shortcut legend's keycaps) plus the self-contained confirm dialog. NONE of
 * these know anything about masks, layers or painting — they are the paint
 * toolbar's vocabulary, not its logic, which is why they lift out cleanly.
 *
 * Split out of paint-mode.js on 2026-07-25 (the size-ratchet god-object
 * reversal): that file was 1,083 lines with an 867-line `installPainter`
 * closure. Bodies moved here VERBATIM — `createConfirmModal` wraps the one
 * that needs the painter's `state.modalOpen` flag so its body could stay
 * byte-identical rather than being rewritten to take a parameter.
 *
 * @module ui/paint-mode-widgets
 */

function styleControl(el) {
  Object.assign(el.style, {
    pointerEvents: 'auto',
    background: 'rgba(10,14,22,0.9)',
    border: '1px solid rgba(143,214,255,0.4)',
    borderRadius: '5px',
    color: '#cfe8ff',
    font: '10px/1.2 Signika, sans-serif',
    padding: '3px 5px',
  });
}

function label(text) {
  const s = document.createElement('span');
  s.textContent = text;
  s.style.opacity = '0.7';
  return s;
}

/** A keyboard/mouse-button "key" chip — the visible-shortcuts legend's unit. */
function keycap(text) {
  const s = document.createElement('span');
  s.textContent = text;
  Object.assign(s.style, {
    display: 'inline-block',
    fontFamily: "'Courier New', monospace",
    fontSize: '9.5px',
    fontWeight: '700',
    lineHeight: '1',
    padding: '3px 6px',
    borderRadius: '4px',
    border: '1px solid rgba(143,214,255,0.45)',
    background: 'rgba(143,214,255,0.1)',
    color: '#eaf4ff',
  });
  return s;
}

/** One "KEY does X" pair for the legend row. */
function legendItem(keyText, desc) {
  const wrap = document.createElement('span');
  Object.assign(wrap.style, { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px' });
  wrap.append(keycap(keyText));
  const d = document.createElement('span');
  d.textContent = desc;
  d.style.opacity = '0.7';
  wrap.append(d);
  return wrap;
}

function button(text, onClick, accent) {
  const b = document.createElement('button');
  b.textContent = text;
  Object.assign(b.style, {
    pointerEvents: 'auto',
    background: `rgba(${accent},0.16)`,
    border: `1px solid rgba(${accent},0.45)`,
    borderRadius: '6px',
    color: '#eaf4ff',
    font: '11px Signika, sans-serif',
    padding: '5px 10px',
    cursor: 'pointer',
  });
  b.addEventListener('click', onClick);
  return b;
}

/** A labelled range that reads its value from a getter and shows the number. */
function range(labelText, min, max, get, set) {
  const wrap = document.createElement('label');
  Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '5px' });
  const name = label(labelText);
  const val = document.createElement('span');
  Object.assign(val.style, { minWidth: '26px', textAlign: 'right', opacity: '0.85' });
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.value = String(get());
  input.style.width = '84px';
  input.style.pointerEvents = 'auto';
  const paint = () => (val.textContent = String(get()));
  paint();
  input.addEventListener('input', () => {
    set(Number(input.value));
    paint();
  });
  wrap.append(name, input, val);
  return {
    el: wrap,
    sync: () => {
      input.value = String(get());
      paint();
    },
  };
}

/** A segmented 3-way control (Spray/Paint/Erase). */
function segmented(options, get, set) {
  const el = document.createElement('div');
  Object.assign(el.style, { display: 'inline-flex', gap: '3px' });
  const btns = options.map(([text, value]) => {
    const b = document.createElement('button');
    b.textContent = text;
    Object.assign(b.style, {
      pointerEvents: 'auto',
      border: '1px solid rgba(143,214,255,0.4)',
      borderRadius: '5px',
      color: '#cfe8ff',
      font: '10px Signika, sans-serif',
      padding: '4px 8px',
      cursor: 'pointer',
    });
    b.addEventListener('click', () => {
      set(value);
      sync();
    });
    return { b, value };
  });
  el.append(...btns.map((x) => x.b));
  function sync() {
    const cur = get();
    for (const { b, value } of btns)
      b.style.background = value === cur ? 'rgba(143,214,255,0.32)' : 'rgba(143,214,255,0.1)';
  }
  sync();
  return { el, sync };
}

export { styleControl, label, keycap, legendItem, button, range, segmented };

/**
 * A small self-contained confirm dialog (no Foundry-Dialog API dependency);
 * resolves to the chosen button's `action`, or 'cancel' if dismissed.
 *
 * Bound to the painter `state` whose `modalOpen` flag pauses paint input while
 * a dialog is up. Returns the `confirmModal(title, message, buttons)` function
 * itself — a factory purely so the body below could move out of
 * `installPainter` unchanged.
 * @param {{modalOpen: boolean}} state
 */
export function createConfirmModal(state) {
  function confirmModal(title, message, buttons) {
    return new Promise((resolve) => {
      state.modalOpen = true;
      const back = document.createElement('div');
      Object.assign(back.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '200',
        pointerEvents: 'auto',
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      });
      const card = document.createElement('div');
      Object.assign(card.style, {
        background: 'rgba(14,18,28,0.98)',
        border: '1px solid rgba(143,214,255,0.35)',
        borderRadius: '12px',
        padding: '16px 18px',
        maxWidth: '440px',
        color: '#dcecff',
        font: '12px/1.45 Signika, sans-serif',
        boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
      });
      const finish = (action) => {
        state.modalOpen = false;
        back.remove();
        resolve(action);
      };
      const h = document.createElement('div');
      h.textContent = title;
      Object.assign(h.style, { fontWeight: '700', fontSize: '13px', marginBottom: '8px' });
      const m = document.createElement('div');
      m.textContent = message;
      Object.assign(m.style, { marginBottom: '14px', opacity: '0.9' });
      const btnRow = document.createElement('div');
      Object.assign(btnRow.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' });
      for (const b of buttons) btnRow.append(button(b.label, () => finish(b.action), b.accent ?? '143,214,255'));
      back.addEventListener('pointerdown', (ev) => {
        if (ev.target === back) finish('cancel');
      });
      card.append(h, m, btnRow);
      back.append(card);
      document.body.appendChild(back);
    });
  }
  return confirmModal;
}
