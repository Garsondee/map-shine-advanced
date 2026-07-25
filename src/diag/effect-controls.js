/**
 * EFFECT CONTROLS — the generic, schema-driven FOH/ROH renderer every
 * registered effect's debug-panel card is built from (docs/planning/
 * Effects-UI.md). ONE `core/params-schema.js` declaration drives both a small
 * approachable strip (front of house) and a full, categorised technical
 * section (rear of house, behind an "Advanced" disclosure) — no control is
 * ever hand-wired to a specific effect, because every widget here is a
 * `type → element` mapping read straight off the param's own declaration.
 *
 * This is deliberately PLAIN DOM, not Tweakpane: Tweakpane isn't vendored yet
 * (`ui/no-handwritten-controls`, tools/verify-structure.mjs, only matches
 * literal Tweakpane call patterns and allows them in `ui/renderers/` — plain
 * `<input>`/`<select>` construction outside that folder is already how
 * `debug-panel.js`'s own `makeControl` works, so this is consistent with
 * existing precedent, not a new exception). Swapping in the real Tweakpane/
 * ApplicationV2 pair later means changing the RENDERER, not the schema.
 *
 * `groupParamsByCategory` is pure (Node-tested); everything below it builds
 * DOM and is verified live, the same split every other UI module in this
 * project draws (e.g. `scene/paint-mask.js` pure vs `ui/paint-mode.js` glue).
 *
 * @module diag/effect-controls
 */

/**
 * The fixed ROH category order (Effects-UI.md §2), with `Light` added
 * alongside it — candles and every other lighting effect already declare
 * params under it (`effects/candle-flame.js`), and "colour/reach/animation
 * richness of the light this effect casts" doesn't sit naturally under Look
 * (the effect's own visible surface) or Response (couplings to the world).
 * A param with an unrecognised/absent category falls to Technical — visible,
 * never lost (Effects-UI.md §2's own rule).
 * @type {ReadonlyArray<string>}
 */
export const CATEGORY_ORDER = Object.freeze(['Presence', 'Look', 'Light', 'Motion', 'Extent', 'Response', 'Technical']);

/**
 * Sort a params schema into the fixed category order, pure — the ROH's
 * navigation structure, shared by every effect's card. Categories with zero
 * params are omitted (never an empty accordion group). Within a category,
 * params keep the schema's own declared order (the author's authoring order
 * is meaningful; this never re-sorts alphabetically).
 * @param {Record<string, object>} schema
 * @returns {Array<{category: string, keys: string[]}>}
 */
export function groupParamsByCategory(schema) {
  const buckets = new Map(CATEGORY_ORDER.map((c) => [c, []]));
  for (const [key, decl] of Object.entries(schema ?? {})) {
    const cat = CATEGORY_ORDER.includes(decl?.category) ? decl.category : 'Technical';
    buckets.get(cat).push(key);
  }
  return CATEGORY_ORDER.map((category) => ({ category, keys: buckets.get(category) })).filter((g) => g.keys.length > 0);
}

// ---- shared visual language (mirrors debug-panel.js's palette) -----------
const CYAN = '143,214,255';
const TEXT = '#dcecff';
const MUTED = '#8fa3c4';

function styled(tag, style) {
  const el = document.createElement(tag);
  Object.assign(el.style, style);
  return el;
}

function row() {
  return styled('label', {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    flexBasis: '100%',
    font: '10.5px/1.3 Signika, sans-serif',
    color: TEXT,
    pointerEvents: 'auto',
  });
}

function labelSpan(decl, id) {
  const s = styled('span', { flex: '0 0 auto', minWidth: '108px', opacity: '0.9' });
  s.textContent = decl?.label ?? id;
  return s;
}

function formatNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return Math.abs(n) >= 100 ? Math.round(n).toString() : Math.round(n * 100) / 100 + '';
}

/**
 * A float/int param → a labelled range slider + a live numeric readout. The
 * readout updates on every drag tick (`input`); the actual write commits on
 * release (`change`) — live enough to feel responsive, cheap enough that a
 * per-candle edit (which persists to the scene on every commit) never spams
 * a write per pixel of drag.
 */
function buildRangeRow(id, decl, { value, onChange }) {
  const wrap = row();
  wrap.title = decl.help ?? '';
  const input = styled('input', { flex: '1', accentColor: `rgb(${CYAN})`, pointerEvents: 'auto' });
  input.type = 'range';
  input.min = String(decl.min ?? 0);
  input.max = String(decl.max ?? 1);
  input.step = String(decl.step ?? (decl.type === 'int' ? 1 : 0.01));
  input.value = String(value);
  const readout = styled('span', {
    minWidth: '38px',
    textAlign: 'right',
    color: MUTED,
    fontVariantNumeric: 'tabular-nums',
  });
  readout.textContent = formatNum(value);
  input.addEventListener('input', () => {
    readout.textContent = formatNum(input.value);
  });
  input.addEventListener('change', () => {
    onChange(decl.type === 'int' ? parseInt(input.value, 10) : parseFloat(input.value));
  });
  wrap.append(labelSpan(decl, id), input, readout);
  return wrap;
}

/** A bool param → a labelled checkbox, committing immediately (a checkbox has no "drag"). */
function buildCheckboxRow(id, decl, { value, onChange }) {
  const wrap = row();
  wrap.title = decl.help ?? '';
  const input = styled('input', { pointerEvents: 'auto' });
  input.type = 'checkbox';
  input.checked = value === true;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.append(labelSpan(decl, id), input);
  return wrap;
}

/** A color param → a labelled native colour swatch/picker (#rrggbb, matches core/params-schema.js's one storage shape). */
function buildColorRow(id, decl, { value, onChange }) {
  const wrap = row();
  wrap.title = decl.help ?? '';
  const input = styled('input', { pointerEvents: 'auto', width: '36px', height: '20px', padding: '0', border: 'none' });
  input.type = 'color';
  input.value = typeof value === 'string' ? value : (decl.default ?? '#ffaa00');
  input.addEventListener('change', () => onChange(input.value));
  wrap.append(labelSpan(decl, id), input);
  return wrap;
}

/** An enum param → a labelled dropdown of its declared values. */
function buildEnumRow(id, decl, { value, onChange }) {
  const wrap = row();
  wrap.title = decl.help ?? '';
  const select = styled('select', {
    flex: '1',
    pointerEvents: 'auto',
    background: 'rgba(10,14,22,0.9)',
    border: `1px solid rgba(${CYAN},0.4)`,
    borderRadius: '5px',
    color: '#cfe8ff',
    font: '10.5px/1.2 Signika, sans-serif',
    padding: '3px',
  });
  for (const v of decl.values ?? []) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    select.append(opt);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  wrap.append(labelSpan(decl, id), select);
  return wrap;
}

/** A graceful fallback for a param type this renderer has no rich widget for
 * yet (text/vec2/vec3/curve/action — none of which candles use) — a plain
 * readout rather than a silent gap or a throw, so a future effect with an
 * exotic param still gets SOMETHING instead of a missing control. */
function buildReadonlyRow(id, decl, value) {
  const wrap = row();
  wrap.title = decl?.help ?? '';
  const val = styled('span', { color: MUTED });
  val.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
  wrap.append(labelSpan(decl, id), val);
  return wrap;
}

/**
 * The ONE type→widget dispatch — every future effect's params render through
 * this, never a hand-built control (Effects-UI.md §2's tripwire, applied here
 * in plain DOM instead of Tweakpane).
 * @param {string} id @param {object} decl @param {{value: unknown, onChange: (v: unknown) => void}} io
 * @returns {HTMLElement}
 */
export function buildParamControl(id, decl, io) {
  switch (decl?.type) {
    case 'float':
    case 'int':
      return buildRangeRow(id, decl, io);
    case 'bool':
      return buildCheckboxRow(id, decl, io);
    case 'color':
      return buildColorRow(id, decl, io);
    case 'enum':
      return buildEnumRow(id, decl, io);
    default:
      return buildReadonlyRow(id, decl, io.value);
  }
}

/**
 * An "inherit or override" row — a slider that shows the EFFECTIVE value
 * (shared default, or a per-instance override if one is active) plus a small
 * reset icon that clears the override, restoring inheritance. The general
 * shape for ANY per-instance knob with a shared effect-wide default and an
 * optional per-instance override (scene/anchor-catalog.js's `useCustomX`/
 * `customX` pairs) — built here once so a future effect's own per-instance
 * overrides (the candle anchor edit popup is the first user, `ui/anchor-
 * mode.js`) get the identical UX for free, never a bespoke slider per effect.
 *
 * @param {object} args
 * @param {string} args.label @param {string} [args.help]
 * @param {number} args.min @param {number} args.max @param {number} [args.step]
 * @param {number} args.effectiveValue - the value to show/drag (the caller has already resolved shared-vs-override).
 * @param {boolean} args.isOverridden
 * @param {(value: number) => void} args.onDrag - the dragged value on commit; the caller is responsible for turning the override ON alongside it.
 * @param {() => void} args.onResetToShared - the reset icon was clicked; the caller turns the override OFF.
 * @returns {HTMLElement}
 */
export function buildInheritableRangeRow({
  label,
  help,
  min,
  max,
  step,
  effectiveValue,
  isOverridden,
  onDrag,
  onResetToShared,
}) {
  const wrap = row();
  wrap.title = help ?? '';
  const labelEl = styled('span', { flex: '0 0 auto', minWidth: '92px', opacity: '0.9' });
  labelEl.textContent = label + (isOverridden ? ' •' : '');
  const input = styled('input', { flex: '1', accentColor: `rgb(${CYAN})`, pointerEvents: 'auto' });
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step ?? 1);
  input.value = String(effectiveValue);
  const readout = styled('span', {
    minWidth: '38px',
    textAlign: 'right',
    color: MUTED,
    fontVariantNumeric: 'tabular-nums',
  });
  readout.textContent = formatNum(effectiveValue);
  input.addEventListener('input', () => {
    readout.textContent = formatNum(input.value);
  });
  input.addEventListener('change', () => onDrag(parseFloat(input.value)));
  const resetBtn = styled('button', {
    pointerEvents: 'auto',
    border: 'none',
    background: 'transparent',
    cursor: isOverridden ? 'pointer' : 'default',
    color: isOverridden ? `rgb(${CYAN})` : 'rgba(143,214,255,0.25)',
    fontSize: '12px',
    padding: '0 2px',
  });
  resetBtn.type = 'button';
  resetBtn.textContent = '↺';
  resetBtn.title = isOverridden ? 'Match all candles' : 'Already matching all candles';
  resetBtn.disabled = !isOverridden;
  resetBtn.addEventListener('click', () => onResetToShared());
  wrap.append(labelEl, input, readout, resetBtn);
  return wrap;
}

function sectionLabel(text) {
  const el = styled('div', {
    fontSize: '9px',
    letterSpacing: '1.2px',
    textTransform: 'uppercase',
    color: '#7f97ba',
    fontWeight: '600',
    margin: '7px 0 2px',
  });
  el.textContent = text;
  return el;
}

/**
 * Build one effect's FOH + ROH card — the reusable unit every registered
 * effect gets by declaring a params schema + a curated FOH key list, nothing
 * else. Structure: title + enable toggle → a short plain-language FOH strip
 * (`fohKeys`, hand-picked, ≤6 per Effects-UI.md §3.2) → an "Advanced ▾"
 * disclosure holding the FULL schema, categorised (`groupParamsByCategory`).
 *
 * `getValue`/`onChange` are keyed by param id and are the ONLY write path —
 * this module never touches an effect's state directly, so a caller can
 * route writes through whatever cascade/persistence it needs (boot.js wires
 * candles' through `MapShine.setCandle`-style transient overrides).
 *
 * @param {object} args
 * @param {string} args.title
 * @param {string} [args.subtitle]
 * @param {Record<string, object>} args.schema - the effect's params schema.
 * @param {string[]} args.fohKeys - a short, curated subset of `schema`'s keys for the approachable strip.
 * @param {(paramId: string) => unknown} args.getValue
 * @param {(paramId: string, value: unknown) => void} args.onChange
 * @param {boolean} [args.enabled] - omit to hide the enable toggle entirely.
 * @param {(next: boolean) => void} [args.onToggleEnabled]
 * @param {HTMLElement[]} [args.extra] - additional elements appended after the FOH strip (e.g. an "add one" button, a live count) — before the Advanced disclosure.
 * @returns {HTMLElement}
 */
export function buildEffectCard({
  title,
  subtitle,
  schema,
  fohKeys,
  getValue,
  onChange,
  enabled,
  onToggleEnabled,
  extra,
}) {
  const card = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
    padding: '10px 11px',
    border: `1px solid rgba(${CYAN},0.18)`,
    borderRadius: '9px',
    background: `rgba(${CYAN},0.045)`,
    flexBasis: '100%',
  });

  const head = styled('div', { display: 'flex', alignItems: 'center', gap: '8px' });
  const titleEl = styled('span', { fontWeight: '700', fontSize: '11.5px', color: '#eaf4ff' });
  titleEl.textContent = title;
  head.append(titleEl);
  if (subtitle) {
    const sub = styled('span', { fontSize: '9.5px', color: MUTED });
    sub.textContent = subtitle;
    head.append(sub);
  }
  if (typeof onToggleEnabled === 'function') {
    const toggleWrap = styled('label', {
      marginLeft: 'auto',
      display: 'flex',
      alignItems: 'center',
      gap: '5px',
      fontSize: '10px',
      color: MUTED,
      pointerEvents: 'auto',
    });
    const cb = styled('input', { pointerEvents: 'auto' });
    cb.type = 'checkbox';
    cb.checked = enabled === true;
    cb.addEventListener('change', () => onToggleEnabled(cb.checked));
    toggleWrap.append('On', cb);
    head.append(toggleWrap);
  }
  card.append(head);

  const foh = styled('div', { display: 'flex', flexWrap: 'wrap', gap: '4px' });
  for (const id of fohKeys ?? []) {
    const decl = schema?.[id];
    if (!decl) continue; // a curated key that no longer exists in the schema silently drops — never a throw over a rename
    foh.append(buildParamControl(id, decl, { value: getValue(id), onChange: (v) => onChange(id, v) }));
  }
  card.append(foh);

  for (const el of extra ?? []) card.append(el);

  const details = document.createElement('details');
  Object.assign(details.style, {
    border: `1px solid rgba(${CYAN},0.12)`,
    borderRadius: '7px',
    background: `rgba(${CYAN},0.03)`,
  });
  const summary = styled('summary', {
    cursor: 'pointer',
    listStyle: 'none',
    padding: '5px 8px',
    fontSize: '10px',
    fontWeight: '600',
    color: MUTED,
  });
  summary.textContent = 'Advanced ▾';
  details.append(summary);
  const rohBody = styled('div', { display: 'flex', flexDirection: 'column', padding: '2px 8px 8px' });
  for (const { category, keys } of groupParamsByCategory(schema)) {
    rohBody.append(sectionLabel(category));
    const groupWrap = styled('div', { display: 'flex', flexWrap: 'wrap', gap: '4px' });
    for (const id of keys) {
      const decl = schema[id];
      groupWrap.append(buildParamControl(id, decl, { value: getValue(id), onChange: (v) => onChange(id, v) }));
    }
    rohBody.append(groupWrap);
  }
  details.append(rohBody);
  card.append(details);

  return card;
}
