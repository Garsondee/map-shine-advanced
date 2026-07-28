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
 *
 * ⚠️ THE FALLBACK IS A SAFETY NET, NOT A PLACE TO PUT THINGS — and it had
 * quietly become one. `Detail` (fluid's marbling), `Shape` (water's four
 * geometry/threshold knobs) and `Outdoor` (specular's sun bias) were all
 * deliberately authored — `specular.test.mjs` even asserts the last one by
 * name, with a comment explaining why an "Indoor" twin would be an empty group.
 * None of the three was in this list, so `groupParamsByCategory` swept all six
 * params into Technical: the declaration said one thing, the panel drew
 * another, and every test stayed green because the tests checked the
 * DECLARATION while the loss happened in the RENDERER. The categories are
 * real; the vocabulary was just closed against them.
 *
 * Order runs outward from the effect's own surface: what it looks like →
 * what it emits → what it does → how big it is → what it answers to → the
 * machinery. Adding a category here is cheap; an empty one never renders.
 * @type {ReadonlyArray<string>}
 */
export const CATEGORY_ORDER = Object.freeze([
  'Presence',
  'Look',
  'Detail',
  'Light',
  'Motion',
  'Shape',
  'Extent',
  'Outdoor',
  'Response',
  'Technical',
]);

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

/**
 * A tiny open/closed registry for disclosure sections, keyed by a stable string.
 *
 * ⚠️ WHY THIS IS NOT DOM STATE. `debug-panel.js`'s `renderBody()` does
 * `bodyEl.innerHTML = ''` and rebuilds every card from scratch — on every
 * registration, every zone switch, and every `refreshControls()` (which fires on
 * a preset pick, a candle add/remove, and the interface-seam sync). So an
 * `<details open>` attribute cannot survive: the element holding it is thrown
 * away. Before this store existed, opening "Advanced", nudging a slider that
 * happened to refresh, and watching it slam shut was the normal experience.
 *
 * It lives HERE rather than in the panel because view state is the renderer's
 * business — `core/params-schema.js` says exactly that, and its
 * `FORBIDDEN_IN_CONTRACT` list (which rejects `expanded`/`advanced`/`folder` on a
 * param declaration) exists to keep it out of the contract. Module scope, not
 * closure scope, because that is what outlives `innerHTML = ''`.
 *
 * Pure and exported so the invariant that matters — two cards never share one
 * key — is a Node test rather than something a future refactor quietly undoes.
 * @returns {{isOpen: (key: string) => boolean, setOpen: (key: string, next: boolean) => void, keys: () => string[]}}
 */
export function createSectionStore() {
  const open = new Set();
  return {
    isOpen: (key) => open.has(key),
    setOpen: (key, next) => {
      if (next) open.add(key);
      else open.delete(key);
    },
    keys: () => [...open].sort(),
  };
}

/** The panel's live section state. One per module load, deliberately. */
const sections = createSectionStore();

/**
 * The one-line derived readout on a COLLAPSED card's header — the whole reason a
 * collapsed accordion is useful rather than merely short. With ten cards folded
 * shut, this is the only thing distinguishing "working", "off", and "wired but
 * it will never draw because the mask you'd paint into does not exist yet".
 *
 * It is a READOUT, not a param (Params.md §3.6.2) — derived at render time from
 * whatever the effect's own state object already knows.
 *
 * Pure and exported because formatting is where lying instruments are born
 * (`feedback_instruments_must_not_lie`): "0 candles" and "no candles yet" are
 * different claims, and `undefined` must produce silence, never "undefined".
 *
 * @param {object} [a]
 * @param {boolean} [a.enabled] - false wins over everything: an off effect's
 *   counts and missing pieces are not what you need to be told.
 * @param {string} [a.missing] - what is absent, phrased as a noun to follow "no"
 *   (e.g. `'_Specular mask on this floor'`).
 * @param {number} [a.count] - how many instances this effect is drawing.
 * @param {string} [a.noun] - singular noun for `count` (e.g. `'candle'`).
 * @returns {string} '' when there is nothing worth saying — the caller renders
 *   nothing at all rather than an empty element taking up the row.
 */
export function collapsedStatusLine({ enabled, count, noun, missing } = {}) {
  if (enabled === false) return 'off';
  if (typeof missing === 'string' && missing.length > 0) return `no ${missing}`;
  if (Number.isFinite(count) && typeof noun === 'string' && noun.length > 0) {
    if (count === 0) return `no ${noun}s placed yet`;
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
  }
  return '';
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
 * THE ROH HALF OF THE SPLIT: every category group MINUS whatever FOH promoted.
 *
 * ⚠️ ROH IS THE COMPLEMENT OF FOH, NOT THE WHOLE SCHEMA. `buildEffectCard`
 * originally walked every key here, so a promoted key rendered TWICE — once in
 * the strip and again under Advanced — as two independent DOM controls over one
 * param, neither of which re-rendered when the other moved. That is how it was
 * caught: the author's water panel showed Opacity 0.62 in the strip and 1 under
 * Advanced, on the same frame (2026-07-26), with the last-dragged one silently
 * winning. It also defeated the point of the split, which the standing FOH/ROH
 * rule puts as *"why are you using the same controls for both?"* — a curated
 * strip means nothing if everything appears in both halves.
 *
 * Pure and exported so that rule is a Node test rather than something a future
 * card refactor can quietly undo: `buildEffectCard` itself is DOM and therefore
 * only browser-verified (CONVENTIONS §4), which is exactly why the part with
 * the invariant in it lives out here.
 *
 * @param {Record<string, object>} schema
 * @param {string[]} [fohKeys] - the promoted subset. Absent/empty → ROH is the
 *   whole schema, which is the correct degenerate case: an effect with no
 *   curated strip keeps every control, it does not lose them.
 * @returns {{category: string, keys: string[]}[]} Groups in CATEGORY_ORDER,
 *   never containing an empty one — a category whose every key was promoted
 *   yields no group at all rather than a bare heading.
 */
export function rohGroups(schema, fohKeys) {
  const promoted = new Set(fohKeys ?? []);
  const out = [];
  for (const { category, keys } of groupParamsByCategory(schema)) {
    const rest = keys.filter((id) => !promoted.has(id));
    if (rest.length > 0) out.push({ category, keys: rest });
  }
  return out;
}

/**
 * Stop a click inside a `<summary>` from ALSO toggling the disclosure.
 *
 * ⚠️ THE TRAP THIS EXISTS FOR. A `<summary>` toggles its parent `<details>` on
 * any click that reaches it — including one that started on a checkbox or button
 * nested inside. Once the card header became a summary, turning an effect off
 * folded its card shut, and pressing ＋ folded the card shut on the way to the
 * brush. Both read as the control being broken.
 *
 * Belt AND braces, because the two mechanisms fail differently: stopping
 * propagation keeps the event from reaching the summary at all, and the
 * `data-msa-nontoggle` marker lets the summary refuse the default action even if
 * some future browser routes activation another way. `debug-panel.js` applies the
 * same doubled guard to its own header buttons for the drag-capture equivalent.
 * @param {HTMLElement} el
 */
function shieldFromSummary(el) {
  el.dataset.msaNontoggle = '1';
  el.addEventListener('click', (e) => e.stopPropagation());
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
}

/**
 * Build one effect's card — the reusable unit every registered effect gets by
 * declaring a params schema + a curated FOH key list, nothing else.
 *
 * COLLAPSED BY DEFAULT (2026-07-27). The card is a `<details>`; its `<summary>`
 * is a one-line scan row — chevron · icon · title · derived status · ＋ · On —
 * identical in shape for every effect, so ten effects can be read at a glance and
 * the ＋ that adds one to the map is always in the same place. Open state
 * survives the panel's full rebuild via the module-level {@link createSectionStore}.
 *
 * Inside, unchanged: a short plain-language FOH strip (`fohKeys`, hand-picked,
 * ≤6 per Effects-UI.md §3.2) → an "Advanced" disclosure holding EVERYTHING FOH
 * DID NOT PROMOTE, categorised (`groupParamsByCategory`), plus this effect's own
 * diagnostics. The two halves partition the schema; they do not overlap. A key
 * appears in exactly one of them, so there is exactly one live control per param
 * and the halves cannot show different values for the same thing — see the note
 * at the ROH loop for the bug that established this.
 *
 * `getValue`/`onChange` are keyed by param id and are the ONLY write path — this
 * module never touches an effect's state directly, so a caller can route writes
 * through whatever cascade/persistence it needs (boot.js wires candles' through
 * `MapShine.setCandle`-style transient overrides).
 *
 * @param {object} args
 * @param {string} args.id - REQUIRED stable slug; the open-state key and the
 *   card's `data-msa-effect` attribute. Throws when absent, because two cards
 *   silently sharing one open-state key is a far worse failure than a loud one —
 *   and `buildRoutedPanels` already try/catches, so a throw costs one skipped
 *   card and a logged error, never a blank zone.
 * @param {string} [args.icon] - one glyph, shown in the collapsed header.
 * @param {string} args.title
 * @param {string} [args.subtitle] - the card's hover tooltip. It was a rendered
 *   line until 2026-07-27; these are developer notes ("tiers 0–5 — placement ·
 *   tube · flow · film · fill · structure") and they were occupying the row that
 *   now carries the status readout a GM actually needs.
 * @param {string|(() => string)} [args.status] - the derived scan line; see
 *   {@link collapsedStatusLine}. A function is called at build time.
 * @param {Record<string, object>} args.schema - the effect's params schema.
 * @param {string[]} args.fohKeys - a short, curated subset of `schema`'s keys.
 * @param {(paramId: string) => unknown} args.getValue
 * @param {(paramId: string, value: unknown) => void} args.onChange
 * @param {boolean} [args.enabled] - omit to hide the enable toggle entirely.
 * @param {(next: boolean) => void} [args.onToggleEnabled]
 * @param {{label: string, title?: string, onAdd: () => void}} [args.add] - the ＋
 *   affordance: how you put this effect ON the map (paint its mask, place an
 *   instance). Rendered in the collapsed header so it is reachable without
 *   opening anything.
 * @param {HTMLElement[]} [args.extra] - additional elements after the FOH strip.
 * @param {HTMLElement[]} [args.diagnostics] - this effect's probes and status
 *   reports, mounted inside Advanced. Opaque elements — this module never
 *   inspects them, the same contract `extra` has. The panel builds them and
 *   passes them in, which is what keeps `debug-panel.js` and this module free of
 *   any import of each other.
 * @returns {HTMLElement}
 */
export function buildEffectCard({
  id,
  icon,
  title,
  subtitle,
  status,
  schema,
  fohKeys,
  getValue,
  onChange,
  enabled,
  onToggleEnabled,
  add,
  extra,
  diagnostics,
}) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(
      'buildEffectCard: `id` is required — it is the open-state key, and two cards sharing one is silent.'
    );
  }

  const card = document.createElement('details');
  card.dataset.msaEffect = id;
  card.open = sections.isOpen(id);
  Object.assign(card.style, {
    border: `1px solid rgba(${CYAN},0.18)`,
    borderRadius: '9px',
    background: `rgba(${CYAN},0.045)`,
    flexBasis: '100%',
  });
  if (subtitle) card.title = subtitle;
  card.addEventListener('toggle', () => sections.setOpen(id, card.open));

  // ---- the collapsed scan row ----------------------------------------------
  const head = styled('summary', {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    cursor: 'pointer',
    listStyle: 'none',
    padding: '8px 10px',
    userSelect: 'none',
  });
  head.addEventListener('click', (e) => {
    // The second half of the summary guard — see shieldFromSummary.
    if (e.target instanceof Element && e.target.closest('[data-msa-nontoggle]')) e.preventDefault();
  });

  const chev = styled('span', { display: 'inline-block', opacity: '0.55', fontSize: '10px' });
  chev.className = 'msa-chev';
  chev.textContent = '▸';
  head.append(chev);

  if (icon) {
    const ic = styled('span', { fontSize: '12px' });
    ic.textContent = icon;
    head.append(ic);
  }

  const titleEl = styled('span', { fontWeight: '700', fontSize: '11.5px', color: '#eaf4ff' });
  titleEl.textContent = title;
  head.append(titleEl);

  const statusText = typeof status === 'function' ? status() : status;
  if (typeof statusText === 'string' && statusText.length > 0) {
    const st = styled('span', {
      fontSize: '9.5px',
      color: MUTED,
      flex: '1 1 auto',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });
    st.textContent = statusText;
    head.append(st);
  } else {
    head.append(styled('span', { flex: '1 1 auto' })); // the spacer that pushes ＋/On right
  }

  if (add && typeof add.onAdd === 'function') {
    const addBtn = styled('button', {
      pointerEvents: 'auto',
      background: 'rgba(167,255,196,0.16)',
      border: '1px solid rgba(167,255,196,0.42)',
      borderRadius: '6px',
      color: '#eaf4ff',
      font: '10px/1.2 Signika, sans-serif',
      padding: '3px 8px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    });
    addBtn.type = 'button';
    addBtn.textContent = add.label;
    if (add.title) addBtn.title = add.title;
    shieldFromSummary(addBtn);
    addBtn.addEventListener('click', () => add.onAdd());
    head.append(addBtn);
  }

  if (typeof onToggleEnabled === 'function') {
    const toggleWrap = styled('label', {
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
    shieldFromSummary(toggleWrap);
    head.append(toggleWrap);
  }
  card.append(head);

  // ---- the body ------------------------------------------------------------
  const body = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
    padding: '0 11px 10px',
  });

  const foh = styled('div', { display: 'flex', flexWrap: 'wrap', gap: '4px' });
  for (const key of fohKeys ?? []) {
    const decl = schema?.[key];
    if (!decl) continue; // a curated key that no longer exists in the schema silently drops — never a throw over a rename
    foh.append(buildParamControl(key, decl, { value: getValue(key), onChange: (v) => onChange(key, v) }));
  }
  body.append(foh);

  for (const el of extra ?? []) body.append(el);

  const roh = rohGroups(schema, fohKeys);
  const diags = diagnostics ?? [];
  // An effect whose every param was promoted to FOH and which has no diagnostics
  // has nothing to disclose — window light rendered an EMPTY "Advanced ▾" for
  // exactly that reason from the day its 2-key schema landed.
  if (roh.length > 0 || diags.length > 0) {
    const advKey = `${id}:advanced`;
    const details = document.createElement('details');
    details.open = sections.isOpen(advKey);
    details.addEventListener('toggle', () => sections.setOpen(advKey, details.open));
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
    summary.innerHTML = '<span class="msa-chev">▸</span> Advanced';
    details.append(summary);

    const rohBody = styled('div', { display: 'flex', flexDirection: 'column', padding: '2px 8px 8px' });
    for (const { category, keys } of roh) {
      rohBody.append(sectionLabel(category));
      const groupWrap = styled('div', { display: 'flex', flexWrap: 'wrap', gap: '4px' });
      for (const key of keys) {
        const decl = schema[key];
        groupWrap.append(buildParamControl(key, decl, { value: getValue(key), onChange: (v) => onChange(key, v) }));
      }
      rohBody.append(groupWrap);
    }

    // THIS EFFECT'S OWN INSTRUMENTS, in the effect's own card. They lived in the
    // Lab's catch-all "More" drawer until 2026-07-27 — a rail click away from the
    // card they describe — because a report had no way to declare which effect it
    // belonged to. The author's question was the whole brief: "why do I have to go
    // elsewhere to find the specular probe when I should find it under advanced
    // for the specular effect".
    if (diags.length > 0) {
      rohBody.append(sectionLabel('Diagnostics'));
      const diagWrap = styled('div', { display: 'flex', flexWrap: 'wrap', gap: '4px' });
      for (const el of diags) diagWrap.append(el);
      rohBody.append(diagWrap);
    }

    details.append(rohBody);
    body.append(details);
  }

  card.append(body);
  return card;
}
