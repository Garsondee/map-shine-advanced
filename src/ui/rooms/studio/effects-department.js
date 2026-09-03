/**
 * ui/rooms/studio/effects-department.js — the crown jewel (U1, docs/holy/
 * UI-Testament.md §5.2, §9). A NEW card shell (`buildStudioEffectCard`) —
 * NOT a reuse of `diag/effect-controls.js#buildEffectCard`, which is the old
 * panel's OWN accordion shell (copy button, no pin/popout/mask-row/badges).
 * The mock's real Studio `buildCard` (`tools/ui-mock/index.html`) has a
 * genuinely different anatomy — category accent bar, health/tier/scope
 * badges, pin/popout/paint tools, a mask-found/missing row — matching the
 * Testament's own §5.2 diagram exactly. What DOES move here unchanged is the
 * U0 widget canon underneath: `buildParamControl`, `groupParamsByCategory`/
 * `rohGroups`, `collapsedStatusLine` — the substance, re-homed; the shell
 * around it, newly built to the Testament's own spec. That split is what
 * "a re-home, not a rewrite" (U1's own checklist wording) actually means
 * once the old and new shells are compared side by side — see Petition P10.
 *
 * @module ui/rooms/studio/effects-department
 */

import { buildParamControl } from '../../widgets/param-control.js';
import { buildDialControl } from '../../widgets/dial-control.js';
import { rohGroups, collapsedStatusLine, buildSettingsSnapshot } from '../../widgets/param-groups.js';
import { iconMarkup } from '../../widgets/icon-sprite.js';
import { tierChip, scopeGlyph, healthBadge } from '../../widgets/badges.js';

/** Pinned card ids — client-side only, one Set for the module's lifetime (matches the mock's own state.pinned; not persisted across reloads yet). */
const pinned = new Set();
/** Popped-out card ids -> their floating mini-panel element, so the main
 * grid can skip re-rendering a card currently shown as its own window (the
 * FOH/ROH double-control bug's shape, one level up: never render the same
 * live param twice), and so `closeAllPopouts()` can tear them down when the
 * Studio itself closes ("pop-outs are views — closing the Studio closes its
 * children", UI-Testament.md §5.2). */
const poppedOut = new Map();

/** Torn down by shell.js on Studio close. */
export function closeAllPopouts() {
  for (const win of poppedOut.values()) win.remove();
  poppedOut.clear();
}

function sectionLabel(text) {
  const el = document.createElement('div');
  Object.assign(el.style, {
    fontSize: '9px',
    letterSpacing: '1.2px',
    textTransform: 'uppercase',
    color: 'var(--ink2, #7f97ba)',
    fontWeight: '600',
    margin: '7px 0 2px',
  });
  el.textContent = text;
  return el;
}

/**
 * Copy text to the clipboard — the same async-API-then-`execCommand`
 * fallback `diag/effect-controls.js#copyTextToClipboard` uses. Duplicated
 * rather than imported: this shell stays free of any import of the old
 * debug panel, the same boundary that file's own copy of this helper (kept
 * separate from `debug-panel.js`) already draws.
 * @param {string} text @returns {Promise<boolean>}
 */
async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      /* fall through to the execCommand fallback */
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

/**
 * The 📋 header button every OLD debug-panel card already has
 * (`diag/effect-controls.js#buildCopyButton`) — never ported to this shell
 * until now (mythica-machina-press#490). No dedicated icon exists for this
 * in `icon-sprite.js`: this control was never part of the Testament mock's
 * own `buildCard`, so there is nothing there to port an icon FROM — kept as
 * the original's literal glyph rather than hand-drawing a new SVG symbol
 * into a set that file's own header says is ported verbatim, never redrawn.
 *
 * ⚠️ Reads `model` at CLICK time, not at build time — the same trap
 * `buildCopyButton`'s own note documents (its 2026-08-17 bug: a captured
 * build-time snapshot exported stale defaults while the sliders already
 * showed the author's real live values). `model` is already this card's one
 * live source for every other control, rebuilt fresh by its factory on
 * every render, so reading `model.getValue`/`model.enabled` inside the
 * click handler — never hoisted above it — is enough on its own.
 * @param {object} model - see effects-department's own JSDoc typedef below.
 * @returns {HTMLElement}
 */
function buildCopySettingsButton(model) {
  const idleGlyph = '📋';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'hbtn';
  btn.textContent = idleGlyph;
  btn.title = 'Copy every current setting for this effect as text — paste it to Claude instead of a screenshot.';
  Object.assign(btn.style, { width: 'auto', padding: '0 6px', fontSize: '.7rem', flex: '0 0 auto' });
  let resetTimer = null;
  btn.addEventListener('click', async () => {
    const snapshot = buildSettingsSnapshot({
      id: model.id,
      title: model.title,
      enabled: model.enabled,
      schema: model.schema,
      getValue: (key) => model.getValue(key),
    });
    const ok = await copyTextToClipboard(JSON.stringify(snapshot, null, 2));
    clearTimeout(resetTimer);
    btn.textContent = ok ? '✓ Copied' : '✗ Failed';
    btn.style.color = ok ? 'var(--ok, #4bd48c)' : 'var(--fail, #ff9a9a)';
    resetTimer = setTimeout(() => {
      btn.textContent = idleGlyph;
      btn.style.color = '';
    }, 1400);
  });
  return btn;
}

/**
 * One effect's card. `model` is read FRESH each call (never cached — the
 * whole grid rebuilds on every render, same discipline as the mock's own
 * `renderDept`), so `getValue`/`getEnabled` inside it are the live accessors
 * the caller's `modelFactory` returns, not a snapshot.
 * @param {object} model - see effects-department's own JSDoc typedef below.
 * @returns {HTMLElement}
 */
function buildStudioEffectCard(model) {
  const card = document.createElement('article');
  card.dataset.msaEffect = model.id;
  Object.assign(card.style, {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '10px 12px 10px 14px',
    background: 'var(--bg1, #191c25)',
    border: '1px solid var(--line, rgba(196,208,232,.13))',
    borderRadius: 'var(--r-card, 10px)',
    borderLeft: `3px solid var(${model.accVar ?? '--shine'})`,
    opacity: model.enabled === false ? '0.6' : '1',
  });

  // ---- header: icon + name + enable + badges + tools ----------------------
  const head = document.createElement('div');
  Object.assign(head.style, { display: 'flex', alignItems: 'center', gap: '7px' });
  const ic = document.createElement('span');
  ic.style.color = `var(${model.accVar ?? '--shine'})`;
  ic.innerHTML = iconMarkup(model.icon ?? 'gear');
  const nameWrap = document.createElement('span');
  Object.assign(nameWrap.style, { display: 'flex', flexDirection: 'column', lineHeight: '1.2', minWidth: '0' });
  const name = document.createElement('span');
  name.style.fontWeight = '700';
  name.style.fontSize = '.85rem';
  name.textContent = model.title;
  const statusLine = document.createElement('span');
  statusLine.style.cssText =
    'color:var(--ink2,#7f97ba); font-size:.68rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap';
  const statusText =
    typeof model.status === 'function'
      ? model.status()
      : (model.status ?? collapsedStatusLine({ enabled: model.enabled }));
  statusLine.textContent = statusText;
  // The row is tight (icon + name + up to 3 badges + 3-4 tool buttons all
  // share one line), so a long status genuinely does clip behind the CSS
  // ellipsis above — a real `title` means hovering still reveals the whole
  // thing rather than just a dead-end "…".
  if (statusText) statusLine.title = statusText;
  nameWrap.append(name, statusLine);
  head.append(ic, nameWrap);

  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  head.append(spacer);

  if (typeof model.onToggleEnabled === 'function') {
    // The status dot stays a small 9px circle (it's a glance-indicator, not
    // a button that should visually dominate the header) — but a 9px CLICK
    // target is real trouble to hit precisely. `.hbtn` (shell.js) wraps it
    // in the same 24px hit box every other header tool button here uses,
    // same trick as a checkbox's own padded label: small visual, real target.
    const enableBtn = document.createElement('button');
    enableBtn.type = 'button';
    enableBtn.className = 'hbtn';
    enableBtn.title = model.enabled ? 'Enabled — click to turn off' : 'Disabled — click to turn on';
    enableBtn.style.flex = '0 0 auto';
    const dot = document.createElement('span');
    Object.assign(dot.style, {
      width: '9px',
      height: '9px',
      borderRadius: '50%',
      background: model.enabled ? 'var(--ok, #4bd48c)' : 'var(--ink2, #7f97ba)',
      display: 'block',
    });
    enableBtn.append(dot);
    enableBtn.addEventListener('click', () => model.onToggleEnabled(!model.enabled));
    head.append(enableBtn);
  }
  head.append(
    healthBadge({
      declared: model.health?.declared,
      read: model.health?.read,
      onClick: model.health ? model.onOpenHealthReport : undefined,
      plannedReason:
        model.healthPlannedReason ?? 'Control-health (declared − read) waits on the U6 read-tracking proxy.',
    })
  );
  if (model.tier) head.append(tierChip(model.tier));
  head.append(
    scopeGlyph({
      plannedReason:
        model.scopePlannedReason ??
        'Full scene/world/client scope is not wired yet — only an effect’s own enable state has a real world/client duality today.',
    })
  );

  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.className = 'hbtn';
  // State-aware, like the enable dot just above — a pinned card's own button
  // still said "Pin to top" even though clicking it would UNpin; the label
  // needs to describe what THIS click does, not just what the control is.
  pinBtn.title = pinned.has(model.id) ? 'Unpin (remove from top)' : 'Pin to top';
  pinBtn.innerHTML = iconMarkup('pin');
  pinBtn.setAttribute('aria-pressed', String(pinned.has(model.id)));
  Object.assign(pinBtn.style, {
    color: pinned.has(model.id) ? `var(${model.accVar ?? '--shine'})` : 'var(--ink2)',
    flex: '0 0 auto',
  });
  pinBtn.addEventListener('click', () => {
    if (pinned.has(model.id)) pinned.delete(model.id);
    else pinned.add(model.id);
    model.onRequestRerender?.();
  });
  head.append(pinBtn);

  if (typeof model.onPopOut === 'function') {
    const popBtn = document.createElement('button');
    popBtn.type = 'button';
    popBtn.className = 'hbtn';
    popBtn.title = 'Pop out for side-by-side tuning';
    popBtn.innerHTML = iconMarkup('popout');
    popBtn.style.color = 'var(--ink2)';
    popBtn.style.flex = '0 0 auto';
    popBtn.addEventListener('click', () => model.onPopOut());
    head.append(popBtn);
  }

  if (typeof model.onPaint === 'function') {
    const paintBtn = document.createElement('button');
    paintBtn.type = 'button';
    // `paintVerb` (2026-08-19, effects-population round) -- most onPaint
    // hooks open the mask brush ("Paint X"), but candle/lightning have no
    // mask at all: their onPaint opens click-to-place ANCHOR mode instead.
    // Defaults to the original wording so every already-shipped card (water
    // included) is unaffected.
    paintBtn.title = `${model.paintVerb ?? 'Paint'} ${model.title} on the map`;
    paintBtn.className = 'hbtn';
    paintBtn.innerHTML = iconMarkup('brush');
    paintBtn.style.color = 'var(--ink2)';
    paintBtn.style.flex = '0 0 auto';
    paintBtn.addEventListener('click', () => model.onPaint());
    head.append(paintBtn);
  }
  // The copy-settings button — see `buildCopySettingsButton`'s own note.
  // Same "skip when there's nothing to copy" guard `buildEffectCard` uses.
  if (model.schema && Object.keys(model.schema).length > 0) {
    head.append(buildCopySettingsButton(model));
  }
  card.append(head);

  // ---- mask-found/missing row ----------------------------------------------
  if (model.mask) {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      fontSize: '.7rem',
      padding: '4px 8px',
      borderRadius: '6px',
      background: model.mask.found
        ? 'color-mix(in oklab, var(--ok) 12%, transparent)'
        : 'color-mix(in oklab, var(--fail) 10%, transparent)',
      color: model.mask.found ? 'var(--ok)' : 'var(--fail)',
    });
    row.innerHTML = model.mask.found
      ? `${iconMarkup('check')} <code>${model.mask.suffix}</code> mask found`
      : `${iconMarkup('warn')} Needs a <code>${model.mask.suffix}</code> mask`;
    if (!model.mask.found && typeof model.onPaint === 'function') {
      const paintLink = document.createElement('button');
      paintLink.type = 'button';
      paintLink.className = 'msa-inline-paint';
      paintLink.textContent = 'Paint one';
      Object.assign(paintLink.style, {
        marginLeft: 'auto',
        color: 'inherit',
        textDecoration: 'underline',
        fontSize: 'inherit',
      });
      paintLink.addEventListener('click', () => model.onPaint());
      row.append(paintLink);
    }
    card.append(row);
  }

  // ---- FOH strip: presets (if any) + fohKeys --------------------------------
  const foh = document.createElement('div');
  Object.assign(foh.style, { display: 'flex', flexWrap: 'wrap', gap: '4px' });
  if (Array.isArray(model.presets) && model.presets.length > 0) {
    const presetRow = document.createElement('div');
    presetRow.style.flexBasis = '100%';
    const select = document.createElement('select');
    select.style.cssText =
      'background:var(--bg2); border:1px solid var(--line); border-radius:var(--r-ctl,6px); padding:3px 6px; color:var(--ink0); font-size:.72rem';
    select.append(new Option('— preset —', ''));
    for (const p of model.presets) select.append(new Option(p, p));
    select.addEventListener('change', () => {
      if (select.value) model.onPresetPick?.(select.value);
      select.value = '';
    });
    presetRow.append(select);
    foh.append(presetRow);
  }
  // U6: authored dials REPLACE the raw fohKeys strip where an effect
  // declares them — `fohKeys` remains the fallback (and, unchanged, the
  // ROH-exclusion set below regardless of which form FOH takes; a dial's
  // driven params can still be hand-tuned in Advanced).
  const dialIds = model.dialsSchema ? Object.keys(model.dialsSchema) : [];
  if (dialIds.length > 0) {
    const currentValues = {};
    for (const key of Object.keys(model.schema ?? {})) currentValues[key] = model.getValue(key);
    for (const dialId of dialIds) {
      const decl = model.dialsSchema[dialId];
      const dialRow = buildDialControl(dialId, decl, {
        paramValues: currentValues,
        onChange: (driven) => {
          for (const [paramKey, value] of Object.entries(driven)) model.onChange(paramKey, value);
        },
      });
      dialRow.classList.add('msa-dial-row');
      foh.append(dialRow);
    }
  } else {
    for (const key of model.fohKeys ?? []) {
      const decl = model.schema?.[key];
      if (!decl) continue;
      const row = buildParamControl(key, decl, { value: model.getValue(key), onChange: (v) => model.onChange(key, v) });
      row.dataset.msaParam = key;
      row.classList.add('msa-param-row');
      foh.append(row);
    }
  }
  card.append(foh);

  // ---- extra: opaque, always-visible content (UI parity plan, phase 5a) ---
  // The door `diag/effect-controls.js#buildEffectCard` has always had, for
  // content that doesn't fit the flat param-control shape — a hand-built
  // debug-channel <select>, a preset row that isn't a plain enum, etc.
  // Right after the FOH strip, same position that file uses.
  //
  // ⚠️ REAL BUG, CAUGHT LIVE (author console trace, first Studio open after
  // this round's UI-parity work: "TypeError: function is not iterable") —
  // `resolveExtra` below, not a bare `model.extra ?? []`. Both a THUNK
  // (`() => HTMLElement[]`, e.g. Wind's card: `extra: () =>
  // MapShine.debug.buildEffectAttachments('wind')`, built fresh every
  // render so a late-registered {effect:'wind'} diagnostic shows up without
  // a stale card) AND a plain ARRAY (water's own card factory already
  // re-runs its whole buildFn fresh every render, so a thunk would be
  // redundant ceremony there — `extra: [buildWaterDebugSelect()]`) are
  // real, intentional shapes in actual use today; this typedef only ever
  // documented the array form, and iterating a bare function throws exactly
  // this error.
  const resolveExtra = (v) => (typeof v === 'function' ? (v() ?? []) : (v ?? []));
  for (const el of resolveExtra(model.extra)) card.append(el);

  // ---- Advanced: ROH, categorised, + extraAdvanced -------------------------
  const roh = rohGroups(model.schema, model.fohKeys);
  const extraAdvanced = resolveExtra(model.extraAdvanced);
  if (roh.length > 0 || extraAdvanced.length > 0) {
    const details = document.createElement('details');
    Object.assign(details.style, { border: '1px solid var(--line)', borderRadius: '7px', background: 'var(--bg2)' });
    const summary = document.createElement('summary');
    summary.style.cssText =
      'cursor:pointer; padding:5px 8px; font-size:.7rem; font-weight:600; color:var(--ink2); display:flex; align-items:center; gap:5px';
    // A `.msa-chev` span, not a `▸` baked into textContent — `<summary>`
    // already draws its OWN native disclosure triangle (suppressed via
    // shell.js's `summary::-webkit-details-marker` rule, but only once
    // something suppresses it); before that CSS existed this rendered as
    // TWO triangles side by side, the browser's plus this hand-typed one.
    // Same shape diag/effect-controls.js's own `.msa-chev` already solved —
    // ported the class name so the two panels' Advanced sections match.
    const chev = document.createElement('span');
    chev.className = 'msa-chev';
    chev.textContent = '▸';
    summary.append(chev, document.createTextNode(`Advanced — ${roh.reduce((n, g) => n + g.keys.length, 0)} controls`));
    details.append(summary);
    const body = document.createElement('div');
    Object.assign(body.style, { display: 'flex', flexDirection: 'column', padding: '2px 8px 8px' });
    for (const { category, keys } of roh) {
      body.append(sectionLabel(category));
      const wrap = document.createElement('div');
      Object.assign(wrap.style, { display: 'flex', flexWrap: 'wrap', gap: '4px' });
      for (const key of keys) {
        const decl = model.schema[key];
        const row = buildParamControl(key, decl, {
          value: model.getValue(key),
          onChange: (v) => model.onChange(key, v),
        });
        row.dataset.msaParam = key;
        row.classList.add('msa-param-row');
        wrap.append(row);
      }
      body.append(wrap);
    }
    // Opaque advanced-only content (specular's 3 shimmer-layer strips is
    // the canonical case — see diag/effect-controls.js's own JSDoc) — after
    // the categorised ROH groups, same position the old shell uses.
    for (const el of extraAdvanced) body.append(el);
    details.append(body);
    card.append(details);
  }

  return card;
}

/**
 * @typedef {object} EffectCardModel
 * @property {string} id @property {string} title @property {string} [icon]
 * @property {string} [accVar] - a LANTERN category token name, e.g. '--c-atmos'.
 * @property {string} [filterCategory] - one of FILTER_CATEGORIES' keys, for the strip.
 * @property {{tier:number,maxTier?:number,source?:string}} [tier]
 * @property {{suffix:string,found:boolean}} [mask]
 * @property {string[]} [presets] @property {(name:string)=>void} [onPresetPick]
 * @property {Record<string,object>} schema @property {string[]} fohKeys
 * @property {Record<string,import('../../../core/dials-schema.js').DialDecl>} [dialsSchema] -
 *   U6: authored macro dials, replacing the raw fohKeys strip when present
 *   (`ui/widgets/dial-control.js`). Validate with `validateDialsSchema`
 *   against `schema` before shipping — see water.js's own `WATER_DIALS`.
 * @property {{declared:number,read:number,orphaned:string[]}} [health] -
 *   U6: `diag/param-read-health.js#getParamHealth` output, computed FRESH
 *   per model-factory call (never cached — matches `getValue`'s own rule).
 * @property {()=>void} [onOpenHealthReport] - set by renderEffectsDepartment,
 *   not by the model factory; deep-links the health badge to the LAB
 *   department's Control Health report.
 * @property {(paramId:string)=>unknown} getValue
 * @property {(paramId:string,value:unknown)=>void} onChange
 * @property {boolean} [enabled] @property {(next:boolean)=>void} [onToggleEnabled]
 * @property {()=>void} [onPaint] @property {()=>void} [onPopOut]
 * @property {string} [paintVerb] - overrides the paint button's "Paint" verb
 *   (e.g. 'Place' for an anchor-placement onPaint rather than a mask brush).
 * @property {string|(()=>string)} [status]
 * @property {HTMLElement[]|(()=>HTMLElement[])} [extra] - opaque content that
 *   doesn't fit the flat param-control shape (a hand-built debug-channel
 *   select, etc.), rendered right after the FOH strip, always visible. UI
 *   parity plan, phase 5a — mirrors diag/effect-controls.js#buildEffectCard's
 *   own `extra`. A plain array when the model factory itself already runs
 *   fresh every render (water's own card); a thunk when the elements need
 *   building fresh independent of that (Wind's card, built from whatever
 *   {effect:'wind'} diagnostics are registered right now) —
 *   `buildStudioEffectCard` resolves either.
 * @property {HTMLElement[]|(()=>HTMLElement[])} [extraAdvanced] - same idea,
 *   inside the Advanced disclosure after the categorised ROH groups
 *   (specular's 3 shimmer-layer strips is the canonical case). Mirrors that
 *   file's own `extraAdvanced`.
 */

/**
 * The category filter strip. `filterCategory` per effect is this session's
 * own proposal (no per-effect taxonomy exists in src/ today) — worth an
 * author countersign; see Petition P10.
 */
const FILTER_CATEGORIES = Object.freeze({
  gameplay: { label: 'Gameplay', accVar: '--c-gameplay' },
  lighting: { label: 'Lighting', accVar: '--c-lighting' },
  atmos: { label: 'Atmosphere', accVar: '--c-atmos' },
  surface: { label: 'Surface', accVar: '--c-surface' },
  particles: { label: 'Particles', accVar: '--c-particles' },
  post: { label: 'Post', accVar: '--c-post' },
});

let activeFilter = null;

/**
 * Render the EFFECTS department body into `container` (a `.deptscroll`).
 * @param {HTMLElement} container
 * @param {{effectCardFactories: Map<string, () => EffectCardModel>}} ctx
 * @returns {string} the department subtitle for the shell's deptHead.
 */
export function renderEffectsDepartment(container, ctx) {
  const models = [...ctx.effectCardFactories.entries()].map(([id, factory]) => ({ id, model: factory() }));

  const strip = document.createElement('div');
  Object.assign(strip.style, { display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '12px' });
  const grid = document.createElement('div');
  Object.assign(grid.style, {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: '10px',
    alignContent: 'start',
  });

  function makeChip(label, accVar, filterKey) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(activeFilter === filterKey));
    Object.assign(b.style, {
      padding: '4px 10px',
      borderRadius: '999px',
      border: `1px solid ${activeFilter === filterKey ? `var(${accVar})` : 'var(--line)'}`,
      background: activeFilter === filterKey ? `color-mix(in oklab, var(${accVar}) 16%, transparent)` : 'var(--bg2)',
      color: activeFilter === filterKey ? `var(${accVar})` : 'var(--ink1)',
      fontSize: '.72rem',
      cursor: 'pointer',
    });
    b.addEventListener('click', () => {
      activeFilter = filterKey;
      renderEffectsDepartment(container, ctx);
    });
    return b;
  }
  strip.append(makeChip('All', '--shine', null));
  for (const [key, { label, accVar }] of Object.entries(FILTER_CATEGORIES)) strip.append(makeChip(label, accVar, key));

  const visible = models
    .filter(({ model }) => !activeFilter || model.filterCategory === activeFilter)
    .filter(({ id }) => !poppedOut.has(id))
    .sort((a, b) => (pinned.has(b.id) ? 1 : 0) - (pinned.has(a.id) ? 1 : 0));
  for (const { model } of visible) {
    model.onRequestRerender = () => renderEffectsDepartment(container, ctx);
    // U6: the health badge's own click target — "deep-links to the Lab
    // report" (UI-Testament.md §9's own U6 checklist wording). Switches the
    // Studio to LAB, where the Control Health report boot.js registers
    // lives; does not yet auto-run that report on arrival (no stable hook
    // into debug-panel.js's rendered report list from outside it today —
    // named as a real, small follow-up in the U6 Petition, not silently
    // claimed as full automation).
    model.onOpenHealthReport = () => ctx.switchDepartment?.('lab');
    // Detaches to a floating mini-panel for side-by-side lookdev (Testament
    // §5.2). Synthesised here, not per-effect data — every card gets one.
    model.onPopOut = () => {
      poppedOut.set(
        model.id,
        popOutCard(model, ctx, () => renderEffectsDepartment(container, ctx))
      );
      renderEffectsDepartment(container, ctx);
    };
    grid.append(buildStudioEffectCard(model));
  }
  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--ink2); font-size:.8rem; padding:20px';
    empty.textContent =
      models.length === 0
        ? 'No effects registered yet.'
        : poppedOut.size > 0
          ? 'Every matching card is popped out.'
          : 'No effects in this category.';
    grid.append(empty);
  }

  container.innerHTML = '';
  container.append(strip, grid);
  return `${models.length} registered — every card generated from its schema`;
}

/**
 * A card, detached into its own small floating window — a VIEW, never a
 * second live control over the same param (the exact bug FOH/ROH's own
 * partition law exists to prevent, one level up: two independent DOM nodes
 * for one value, silently disagreeing). The grid re-renders without this
 * card the moment it pops out; closing the window re-adds it.
 * @returns {HTMLElement} the floating window, so the caller can track/remove it.
 */
function popOutCard(model, ctx, onClosed) {
  const win = document.createElement('div');
  Object.assign(win.style, {
    position: 'fixed',
    top: `${100 + poppedOut.size * 24}px`,
    left: `${140 + poppedOut.size * 24}px`,
    width: '360px',
    maxHeight: '70vh',
    overflowY: 'auto',
    zIndex: '400',
    background: 'var(--glass)',
    backdropFilter: 'blur(var(--glass-blur))',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--r-room, 14px)',
    boxShadow: 'var(--shadow3)',
    padding: '10px',
  });
  const head = document.createElement('div');
  Object.assign(head.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' });
  const title = document.createElement('span');
  title.style.cssText = 'font-weight:700; font-size:.8rem; color:var(--ink0)';
  title.textContent = model.title;
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.title = 'Close (returns the card to the grid)';
  closeBtn.innerHTML = iconMarkup('x');
  closeBtn.style.color = 'var(--ink2)';
  closeBtn.addEventListener('click', () => {
    poppedOut.delete(model.id);
    win.remove();
    onClosed();
  });
  head.append(title, spacer, closeBtn);
  win.append(head);
  // A fresh model (re-fetched, never the closed-over one) each time the
  // pop-out itself needs to redraw — same "never a captured readout" rule
  // as everything else this canon renders.
  const rerenderCard = () => {
    win.querySelector('[data-msa-effect]')?.remove();
    const freshModel = ctx.effectCardFactories.get(model.id)?.() ?? model;
    freshModel.onRequestRerender = rerenderCard;
    freshModel.onPopOut = undefined; // already popped out; no second popout button on a popout
    win.append(buildStudioEffectCard(freshModel));
  };
  rerenderCard();
  document.body.appendChild(win);
  return win;
}
