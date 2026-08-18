/**
 * ui/widgets/param-control.js — the ONE type→widget mapping every room reads
 * a `core/params-schema.js` declaration through (Effects-UI.md §2's tripwire:
 * no control is ever hand-wired to a specific effect). Extracted from
 * `diag/effect-controls.js` at U0 (docs/holy/UI-Testament.md §9) so the OLD
 * debug-panel and the NEW Studio/Remote share exactly one implementation of
 * "what a float/bool/color/enum/angle param looks like" — `effect-controls.js`
 * re-exports everything below unchanged, so nothing importing from there today
 * had to change.
 *
 * ⚠️ COLOUR IS THEME-AWARE; LAYOUT IS NOT, ON PURPOSE. Every accent/text colour
 * below is `var(--token, <original hardcoded value>)` — inside a LANTERN root
 * (`ui/tokens.js#installTokens`) the real theme token wins, so these widgets
 * render correctly in all 4 themes (the U0 exit gate); mounted anywhere that
 * never defines those custom properties (the OLD debug-panel, today), the
 * fallback is the EXACT value this file replaced, so the old panel's
 * appearance is unchanged by this extraction. Padding/font-size/gap/border-
 * radius are deliberately left as the old panel's own compact values — giving
 * the Studio's own card shell a more spacious LANTERN layout is that shell's
 * decision to make (U1), not something to force from inside the primitives it
 * assembles.
 *
 * This is deliberately PLAIN DOM, not Tweakpane — see `diag/effect-controls.js`'s
 * module header for why, unchanged by this move.
 *
 * @module ui/widgets/param-control
 */

// ---- shared visual language ------------------------------------------------
// Three accent tiers mirror LANTERN's own `--shine`/`--shine-soft`/`--shine-
// glow` triad (every other component in the design already reads these three
// names) rather than inventing a fourth accent scale that only this module
// understands.
const ACCENT = 'var(--shine, rgb(143,214,255))';
const ACCENT_SOFT = 'var(--shine-soft, rgba(143,214,255,0.06))';
const ACCENT_GLOW = 'var(--shine-glow, rgba(143,214,255,0.35))';
const TEXT = 'var(--ink0, #dcecff)';
const MUTED = 'var(--ink1, #8fa3c4)';
const INACTIVE = 'var(--ink2, rgba(143,214,255,0.25))';

export function styled(tag, style) {
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
  const input = styled('input', { flex: '1', accentColor: ACCENT, pointerEvents: 'auto' });
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

/**
 * The eight points of the compass, in bearing order from north, clockwise. The
 * ORDER is load-bearing: {@link nearestCompassPoint} indexes into it by
 * `round(bearing / 45)`, so a reordering silently renames every direction.
 * @type {ReadonlyArray<{label: string, deg: number}>}
 */
export const COMPASS_POINTS = Object.freeze([
  Object.freeze({ label: 'N', deg: 0 }),
  Object.freeze({ label: 'NE', deg: 45 }),
  Object.freeze({ label: 'E', deg: 90 }),
  Object.freeze({ label: 'SE', deg: 135 }),
  Object.freeze({ label: 'S', deg: 180 }),
  Object.freeze({ label: 'SW', deg: 225 }),
  Object.freeze({ label: 'W', deg: 270 }),
  Object.freeze({ label: 'NW', deg: 315 }),
]);

/** How close to a cardinal a click must land before it snaps exactly onto it,
 * in degrees. The author's own ask is *"easily select 'south'"* — with a free
 * dial and no magnet, "south" is 180.000° and a mouse gives you 176. Half of
 * one 45° sector would snap everything and make the in-between headings
 * unreachable; 9° leaves 80% of every sector free. */
export const COMPASS_SNAP_DEG = 9;

/**
 * Wrap any number of degrees into `[0, 360)`. Pure, exported, and the ONLY
 * wrap in this module — see `core/params-schema.js`'s `angle` note for why an
 * angle wraps rather than clamps, and why JS's sign-preserving `%` needs the
 * second modulo to put −5 at 355 instead of leaving it at −5.
 * @param {number} deg
 * @returns {number}
 */
export function wrapDeg(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return 0;
  return ((n % 360) + 360) % 360;
}

/**
 * The compass point a bearing reads as, and whether it is close enough to snap.
 * Pure so the magnet and the label are ONE decision tested in Node, rather than
 * two hand-written readings of the same table inside a pointer handler.
 * @param {number} deg
 * @returns {{label: string, deg: number, delta: number, snap: boolean}} `delta`
 *   is the SIGNED-magnitude distance to that point, always 0..180.
 */
export function nearestCompassPoint(deg) {
  const b = wrapDeg(deg);
  const point = COMPASS_POINTS[Math.round(b / 45) % COMPASS_POINTS.length];
  // Distance the SHORT way round the circle: at bearing 359 the nearest point
  // is N (0), one degree away, not 359 away. Getting this wrong is how a magnet
  // stops working in exactly one of its eight sectors.
  const raw = Math.abs(b - point.deg);
  const delta = Math.min(raw, 360 - raw);
  return { label: point.label, deg: point.deg, delta, snap: delta <= COMPASS_SNAP_DEG };
}

/**
 * An `angle` param → a compass dial you point, plus a readout naming the
 * direction in words.
 *
 * ⚠️ **THE SCREEN MAPPING IS THE WORLD MAPPING, AND THAT IS NOT A COINCIDENCE.**
 * A bearing `b` puts the needle at `(sin b, −cos b)` in SVG coordinates — and
 * this renderer's world space is Y-DOWN too (`vt-pan-viewer.js#updateCamera`:
 * "computeCameraFrustum returns `top = minY` ... so Three maps the smallest
 * world Y to NDC +1 = the top of the screen"). So the same two lines of trig
 * describe both "where the needle points on this dial" and "which way the water
 * travels on the map", which is the whole reason a compass is honest here.
 * `feedback_y_flip_recurring_risk` has been paid five times; the cure is that
 * the widget and the effect agree BY CONSTRUCTION, not by two people
 * remembering the same convention.
 *
 * Commit cadence matches {@link buildRangeRow}: the needle and the readout
 * follow the pointer live, the actual write lands on release.
 */
function buildCompassRow(id, decl, { value, onChange }) {
  const wrap = row();
  wrap.title = decl.help ?? '';
  wrap.style.alignItems = 'flex-start';

  const SIZE = 62;
  const R = 24;
  const C = SIZE / 2;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(SIZE));
  svg.setAttribute('height', String(SIZE));
  svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
  Object.assign(svg.style, { pointerEvents: 'auto', cursor: 'crosshair', touchAction: 'none', flex: '0 0 auto' });

  const ring = document.createElementNS(NS, 'circle');
  ring.setAttribute('cx', String(C));
  ring.setAttribute('cy', String(C));
  ring.setAttribute('r', String(R));
  ring.setAttribute('fill', ACCENT_SOFT);
  ring.setAttribute('stroke', ACCENT_GLOW);
  svg.append(ring);

  // The eight points, drawn as ticks; the four cardinals also get their letter.
  for (const p of COMPASS_POINTS) {
    const rad = (p.deg * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    const major = p.deg % 90 === 0;
    const tick = document.createElementNS(NS, 'line');
    tick.setAttribute('x1', String(C + dx * (R - (major ? 6 : 3))));
    tick.setAttribute('y1', String(C + dy * (R - (major ? 6 : 3))));
    tick.setAttribute('x2', String(C + dx * R));
    tick.setAttribute('y2', String(C + dy * R));
    tick.setAttribute('stroke', major ? ACCENT : ACCENT_GLOW);
    svg.append(tick);
    if (major) {
      const text = document.createElementNS(NS, 'text');
      text.setAttribute('x', String(C + dx * (R - 12)));
      text.setAttribute('y', String(C + dy * (R - 12) + 3));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '7');
      text.setAttribute('fill', MUTED);
      text.textContent = p.label;
      svg.append(text);
    }
  }

  // THE NEEDLE — an arrow from the hub, pointing the way the value points.
  const needle = document.createElementNS(NS, 'polygon');
  needle.setAttribute('fill', ACCENT);
  svg.append(needle);
  const hub = document.createElementNS(NS, 'circle');
  hub.setAttribute('cx', String(C));
  hub.setAttribute('cy', String(C));
  hub.setAttribute('r', '2');
  hub.setAttribute('fill', ACCENT);
  svg.append(hub);

  const readout = styled('span', { color: MUTED, fontVariantNumeric: 'tabular-nums', minWidth: '54px' });

  let shown = wrapDeg(value ?? decl.default ?? 0);
  function paint(deg) {
    shown = wrapDeg(deg);
    const rad = (shown * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    // A triangle: tip at the rim, two shoulders either side of the hub, found
    // by rotating the direction 90° rather than by a second trig call.
    const tipX = C + dx * (R - 4);
    const tipY = C + dy * (R - 4);
    const px = -dy;
    const py = dx;
    needle.setAttribute(
      'points',
      `${tipX},${tipY} ${C + px * 4},${C + py * 4} ${C - px * 4},${C - py * 4} ${C - dx * 7},${C - dy * 7}`
    );
    const near = nearestCompassPoint(shown);
    readout.textContent = near.delta < 0.5 ? near.label : `${Math.round(shown)}°`;
  }
  paint(shown);

  /** Pointer position → bearing, with the cardinal magnet applied. Returns null
   * for a press exactly on the hub, where there is no direction to read. */
  function bearingAt(event) {
    const box = svg.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    if (Math.hypot(dx, dy) < 3) return null;
    // `atan2(dx, −dy)`: north is up and bearings run clockwise, which is the
    // inverse of the `(sin, −cos)` used to draw. Same convention, one place.
    const raw = wrapDeg((Math.atan2(dx, -dy) * 180) / Math.PI);
    const near = nearestCompassPoint(raw);
    return near.snap ? near.deg : Math.round(raw);
  }

  let dragging = false;
  svg.addEventListener('pointerdown', (e) => {
    const deg = bearingAt(e);
    if (deg === null) return;
    // ⚠️ PAINT FIRST, CAPTURE SECOND, AND THE CAPTURE IS ALLOWED TO FAIL.
    // Found by mounting this widget in a real browser (2026-08-16):
    // `setPointerCapture` THROWS `NotFoundError` when the pointer id is not
    // currently active — which happens for real if the pointer is released
    // between the browser dispatching this event and the handler running, and
    // for every synthetic event a test can generate. In the original order
    // (capture, then paint) that throw aborted the handler AFTER `dragging`
    // was set and BEFORE the new heading was recorded — so the release below
    // then fired `onChange` with the PREVIOUS heading. A click on south
    // silently committed east. Capture is a convenience (it keeps a drag alive
    // outside the dial); the heading is the product, so the product happens
    // first and the convenience is wrapped.
    paint(deg);
    dragging = true;
    try {
      svg.setPointerCapture(e.pointerId);
    } catch (_) {
      /* no capture: a drag that leaves the dial simply stops tracking, which
         is a degraded control rather than a wrong one */
    }
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const deg = bearingAt(e);
    if (deg !== null) paint(deg);
  });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      svg.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* the capture is already gone — releasing twice is not an error worth surfacing */
    }
    onChange(shown);
  };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', finish);

  const stack = styled('div', { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1' });
  stack.append(readout);
  wrap.append(labelSpan(decl, id), svg, stack);
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
    background: 'var(--bg2, rgba(10,14,22,0.9))',
    border: `1px solid ${ACCENT_GLOW}`,
    borderRadius: '5px',
    color: 'var(--ink0, #cfe8ff)',
    font: '10.5px/1.2 Signika, sans-serif',
    padding: '3px',
  });
  for (const v of decl.values ?? []) {
    const opt = document.createElement('option');
    opt.value = v;
    // OPTIONAL `valueLabels` (2026-07-26): a param whose enum ids are machine
    // strings ('shadow-skyreach') can hand over readable ones ("Shadows —
    // sky-reach only") without the id itself having to be prose. Falls back to
    // the id, so every existing enum renders exactly as before.
    opt.textContent = decl.valueLabels?.[v] ?? v;
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
 * Mark an already-built control row as `status:'planned'` (docs/holy/UI-
 * Testament.md, U0) — the author's own ask: *"mark them in red or something
 * like that with a tooltip explaining that these features aren't ready to be
 * hooked up yet."* Two signals, neither of which is colour ALONE:
 *  1. A dashed left edge in `--fail` — colour, but paired with a SHAPE (dashed,
 *     not solid) so the marking survives a colourblind read too.
 *  2. A small "planned" glyph ahead of the label — the non-colour signal.
 * The tooltip carries `plannedReason` (appended after any existing `help`, so
 * neither is lost) and the control is left FULLY INTERACTIVE — never
 * `disabled` — so you can still see what it would do; only the wiring behind
 * it is missing. `validateParamsSchema` already guarantees `plannedReason` is
 * a real sentence whenever `status:'planned'` is declared, so this never
 * renders an empty or stale explanation.
 * @param {HTMLElement} el @param {import('../../core/params-schema.js').ParamDecl} decl
 * @returns {HTMLElement}
 */
function decorateAsPlanned(el, decl) {
  el.style.borderLeft = '2px dashed var(--fail, #ef6d5a)';
  el.style.paddingLeft = '6px';
  el.title = decl.help ? `${decl.help} — ${decl.plannedReason}` : decl.plannedReason;
  const glyph = styled('span', {
    flex: '0 0 auto',
    color: 'var(--fail, #ef6d5a)',
    fontSize: '9px',
    letterSpacing: '.04em',
  });
  glyph.textContent = '◇ planned';
  el.prepend(glyph);
  return el;
}

/**
 * The ONE type→widget dispatch — every future effect's params render through
 * this, never a hand-built control (Effects-UI.md §2's tripwire, applied here
 * in plain DOM instead of Tweakpane).
 * @param {string} id @param {object} decl @param {{value: unknown, onChange: (v: unknown) => void}} io
 * @returns {HTMLElement}
 */
export function buildParamControl(id, decl, io) {
  const el = (() => {
    switch (decl?.type) {
      case 'float':
      case 'int':
        return buildRangeRow(id, decl, io);
      case 'angle':
        return buildCompassRow(id, decl, io);
      case 'bool':
        return buildCheckboxRow(id, decl, io);
      case 'color':
        return buildColorRow(id, decl, io);
      case 'enum':
        return buildEnumRow(id, decl, io);
      default:
        return buildReadonlyRow(id, decl, io.value);
    }
  })();
  return decl?.status === 'planned' ? decorateAsPlanned(el, decl) : el;
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
  const input = styled('input', { flex: '1', accentColor: ACCENT, pointerEvents: 'auto' });
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
    color: isOverridden ? ACCENT : INACTIVE,
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
