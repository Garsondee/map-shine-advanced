/**
 * ui/widgets/dial-control.js — ONE macro dial control (U6, docs/holy/
 * UI-Testament.md §9, `core/dials-schema.js`). Deliberately a SEPARATE
 * widget from `param-control.js#buildRangeRow`, not a reskin of it: a dial
 * writes MULTIPLE params through `resolveDialDrives`, never a single
 * `onChange(value)` — the two controls share a look (a labelled range
 * slider) but not a write contract, and folding them into one function
 * would mean threading dial-only plumbing through every raw-param call site.
 *
 * Visual language matches `param-control.js` exactly (`styled`/`row`
 * shape, the same ACCENT/MUTED tokens) rather than inventing a second
 * style — a dial and a raw param slider sitting in the same FOH strip
 * should read as siblings, not two different widget systems.
 *
 * @module ui/widgets/dial-control
 */

import { resolveDialDrives, dialPositionFromParams } from '../../core/dials-schema.js';
import { attachFineDrag, createFineDragHandle } from './fine-drag.js';

const ACCENT = 'var(--shine, rgb(143,214,255))';
const TEXT = 'var(--ink0, #dcecff)';
const MUTED = 'var(--ink1, #8fa3c4)';

function styled(tag, style) {
  const el = document.createElement(tag);
  Object.assign(el.style, style);
  return el;
}

function formatNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return Math.abs(n) >= 100 ? Math.round(n).toString() : Math.round(n * 100) / 100 + '';
}

/**
 * One dial: a labelled range slider whose value is a POSITION in
 * `decl.range`, not a param value — moving it calls `onChange` with the
 * FULL map `resolveDialDrives` computes (`{paramKey: value, ...}`), one
 * write per driven param, exactly matching how a hand-dragged ROH control
 * over each of those same params would write.
 *
 * @param {string} id - the dial's own schema key (e.g. `'murkiness'`).
 * @param {import('../../core/dials-schema.js').DialDecl} decl
 * @param {{
 *   paramValues: Record<string, unknown>,
 *   onChange: (drivenValues: Record<string, number>) => void,
 * }} handlers - `paramValues` is the effect's CURRENT resolved params (used
 *   only to derive the slider's starting position via
 *   `dialPositionFromParams` — see that function's own doc for why this is
 *   an approximation, not a stored value).
 * @returns {HTMLElement}
 */
export function buildDialControl(id, decl, { paramValues, onChange }) {
  const wrap = styled('label', {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    flexBasis: '100%',
    font: '10.5px/1.3 Signika, sans-serif',
    color: TEXT,
    pointerEvents: 'auto',
  });
  wrap.title = decl.help ?? '';
  wrap.dataset.msaDial = id;

  const labelSpan = styled('span', { flex: '0 0 auto', minWidth: '108px', opacity: '0.9' });
  labelSpan.textContent = decl.label ?? id;

  const [lo, hi] = decl.range;
  const startPos = dialPositionFromParams(decl, paramValues ?? {});

  const input = styled('input', { flex: '1', accentColor: ACCENT, pointerEvents: 'auto' });
  input.type = 'range';
  input.min = String(lo);
  input.max = String(hi);
  // 200 steps across the dial's own range — fine enough to feel continuous
  // on any range (a [0,1] dial and a [0,400] dial both deserve a smooth
  // drag), independent of any single driven param's own `step`.
  input.step = String((hi - lo) / 200 || 0.01);
  input.value = String(startPos);

  const readout = styled('span', {
    minWidth: '38px',
    textAlign: 'right',
    color: MUTED,
    fontVariantNumeric: 'tabular-nums',
  });
  readout.textContent = formatNum(startPos);

  input.addEventListener('input', () => {
    readout.textContent = formatNum(input.value);
  });
  input.addEventListener('change', () => {
    onChange(resolveDialDrives(decl, parseFloat(input.value)));
  });
  attachFineDrag(input);
  const handle = createFineDragHandle(input);

  wrap.append(labelSpan, input, handle, readout);
  return wrap;
}
