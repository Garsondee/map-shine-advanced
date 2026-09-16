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

/** Pinned card ids — one Set for the module's lifetime, seeded once from the
 * persisted client setting (see `pinnedSeeded` below) and written back on
 * every render. Matches the mock's own `state.pinned`. */
const pinned = new Set();
/** Has `pinned` been seeded from `ctx.getPinnedEffects()` yet? Guards against
 * re-seeding (and so clobbering a live toggle) on every render — this
 * module has no per-instance state to hang it on, same reasoning as
 * `activeFilter` just below being module-level too. */
let pinnedSeeded = false;
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
    gap: '8px',
    padding: '12px 14px 12px 16px',
    background: 'var(--bg1, #191c25)',
    border: '1px solid var(--line, rgba(196,208,232,.13))',
    borderRadius: 'var(--r-card, 10px)',
    borderLeft: `3px solid var(${model.accVar ?? '--shine'})`,
    opacity: model.enabled === false ? '0.6' : '1',
  });

  // ---- header: two rows (mythica-machina-press#548) ------------------------
  // Row 1 is IDENTITY (icon + title + enable) and nothing else; row 2 is
  // META + TOOLS (health/tier/scope badges, then pin/popout/paint/copy).
  // The old single-row header packed up to ten flex children (icon, name,
  // toggle, 3 badges, 4 tool buttons) onto one line — on any card with a
  // longer title (Candle flame, Lightning, Precipitation) plus its full
  // badge/tool set, that left the title's own box only a few px wide. The
  // title `name` span below had no overflow handling, and a flex item's
  // default `min-width:auto` means it refuses to shrink to fit — so the
  // overflowing tail of the title rendered OUTSIDE its box and got painted
  // over by whichever badge/button came right after it in the DOM. Splitting
  // into two rows means row 1 only ever has three children (icon, title,
  // toggle) fighting for width, and the title now genuinely truncates
  // (`overflow:hidden` + ellipsis) instead of spilling into its neighbour.
  const head = document.createElement('div');
  Object.assign(head.style, { display: 'flex', flexDirection: 'column', gap: '5px' });

  // ---- row 1: icon + name/status + enable -----------------------------
  const headTop = document.createElement('div');
  Object.assign(headTop.style, { display: 'flex', alignItems: 'center', gap: '8px' });
  const ic = document.createElement('span');
  ic.style.color = `var(${model.accVar ?? '--shine'})`;
  ic.style.flex = '0 0 auto';
  ic.innerHTML = iconMarkup(model.icon ?? 'gear');
  const nameWrap = document.createElement('span');
  Object.assign(nameWrap.style, {
    display: 'flex',
    flexDirection: 'column',
    lineHeight: '1.2',
    minWidth: '0',
    flex: '1 1 auto',
    overflow: 'hidden',
  });
  const name = document.createElement('span');
  Object.assign(name.style, {
    fontWeight: '700',
    fontSize: '.85rem',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  });
  name.textContent = model.title;
  // A real `title` attribute so a truncated name is still readable on hover
  // — same reasoning as `statusLine.title` just below.
  name.title = model.title ?? '';
  const statusLine = document.createElement('span');
  statusLine.style.cssText =
    'color:var(--ink2,#7f97ba); font-size:.68rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap';
  const statusText =
    typeof model.status === 'function'
      ? model.status()
      : (model.status ?? collapsedStatusLine({ enabled: model.enabled }));
  statusLine.textContent = statusText;
  if (statusText) statusLine.title = statusText;
  nameWrap.append(name, statusLine);
  headTop.append(ic, nameWrap);

  if (typeof model.onToggleEnabled === 'function') {
    // A real track+thumb switch (mythica-machina-press#550) — the old
    // control was a bare 9px status dot, indistinguishable from the health/
    // tier/scope badges sitting right beside it, so even a correct redraw
    // didn't read as "a toggle, and here's its new state." Colour AND thumb
    // position both flip now, matching the standard on/off idiom.
    // `model.enabled === false` is the one explicit "off" case (mirrors the
    // card's own opacity check above) — undefined reads as on, same default.
    const isOn = model.enabled !== false;
    const enableBtn = document.createElement('button');
    enableBtn.type = 'button';
    enableBtn.setAttribute('role', 'switch');
    enableBtn.setAttribute('aria-checked', String(isOn));
    enableBtn.title = isOn ? 'Enabled — click to turn off' : 'Disabled — click to turn on';
    Object.assign(enableBtn.style, {
      flex: '0 0 auto',
      width: '28px',
      height: '16px',
      padding: '2px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: isOn ? 'flex-end' : 'flex-start',
      borderRadius: '999px',
      border: '1px solid ' + (isOn ? 'transparent' : 'var(--line, rgba(196,208,232,.13))'),
      background: isOn ? 'var(--ok, #4bd48c)' : 'var(--bg3, rgba(196,208,232,.13))',
      cursor: 'pointer',
    });
    const thumb = document.createElement('span');
    Object.assign(thumb.style, {
      width: '12px',
      height: '12px',
      borderRadius: '50%',
      background: isOn ? '#0d1016' : 'var(--ink2, #7f97ba)',
      display: 'block',
    });
    enableBtn.append(thumb);
    enableBtn.addEventListener('click', () => {
      model.onToggleEnabled(!isOn);
      // The write behind onToggleEnabled settles through a Promise chain
      // (write the setting, then re-resolve the cascade — see e.g.
      // boot.js#setCandle) even though it's a same-tick client setting under
      // the hood, so a synchronous rerender here would just redraw this
      // exact pre-click snapshot. Every microtask that chain queues has
      // drained by the next animation frame — the earliest rerender that's
      // guaranteed to read the settled state rather than guess at it, and
      // still effectively instant to the eye.
      requestAnimationFrame(() => model.onRequestRerender?.());
    });
    headTop.append(enableBtn);
  }
  head.append(headTop);

  // ---- row 2: health/tier/scope badges, then pin/popout/paint/copy ----
  const headMeta = document.createElement('div');
  Object.assign(headMeta.style, { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' });
  headMeta.append(
    healthBadge({
      declared: model.health?.declared,
      read: model.health?.read,
      onClick: model.health ? model.onOpenHealthReport : undefined,
      plannedReason:
        model.healthPlannedReason ?? 'Control-health (declared − read) waits on the U6 read-tracking proxy.',
    })
  );
  if (model.tier) headMeta.append(tierChip(model.tier));
  headMeta.append(
    scopeGlyph({
      schema: model.schema,
      plannedReason:
        model.scopePlannedReason ??
        'Full scene/world/client scope is not wired yet — only an effect’s own enable state has a real world/client duality today.',
    })
  );

  const toolSpacer = document.createElement('span');
  toolSpacer.style.flex = '1';
  headMeta.append(toolSpacer);

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
  headMeta.append(pinBtn);

  if (typeof model.onPopOut === 'function') {
    const popBtn = document.createElement('button');
    popBtn.type = 'button';
    popBtn.className = 'hbtn';
    popBtn.title = 'Pop out for side-by-side tuning';
    popBtn.innerHTML = iconMarkup('popout');
    popBtn.style.color = 'var(--ink2)';
    popBtn.style.flex = '0 0 auto';
    popBtn.addEventListener('click', () => model.onPopOut());
    headMeta.append(popBtn);
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
    headMeta.append(paintBtn);
  }
  // The copy-settings button — see `buildCopySettingsButton`'s own note.
  // Same "skip when there's nothing to copy" guard `buildEffectCard` uses.
  if (model.schema && Object.keys(model.schema).length > 0) {
    headMeta.append(buildCopySettingsButton(model));
  }
  head.append(headMeta);
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
  const hasBuiltinPresets = Array.isArray(model.presets) && model.presets.length > 0;
  // MY PRESETS (mythica-machina-press#102) — the world-scoped named-preset
  // library (MapShine.saveEffectPreset/applyEffectPreset/listEffectPresets/
  // deleteEffectPreset, foundry/effect-preset-persistence.js) has existed
  // since that issue's own commit; this is the missing UI, added generically
  // here rather than per-effect so EVERY card gets it, not just the four
  // that happen to declare a built-in `presets` table. Merged into the SAME
  // dropdown as any built-in presets (a GM shouldn't need to know or care
  // which kind a given name is) via <optgroup>, with a `user:`-prefixed
  // option value so the change handler can tell the two apart without a
  // second data structure — built-ins keep calling the existing
  // `onPresetPick`, user ones go through `applyMyPreset` instead. Delete
  // only ever targets a user preset — a built-in one isn't in the library
  // this deletes from at all.
  const hasMyPresetsApi = typeof model.listMyPresets === 'function';
  if (hasBuiltinPresets || hasMyPresetsApi) {
    const presetRow = document.createElement('div');
    Object.assign(presetRow.style, { flexBasis: '100%', display: 'flex', gap: '4px', alignItems: 'center' });
    const select = document.createElement('select');
    select.style.cssText =
      'background:var(--bg2); border:1px solid var(--line); border-radius:var(--r-ctl,6px); padding:3px 6px; color:var(--ink0); font-size:.72rem; flex:1; min-width:0';
    const myPresetNames = hasMyPresetsApi ? model.listMyPresets() : [];
    function fillOptions() {
      select.innerHTML = '';
      select.append(new Option('— preset —', ''));
      if (hasBuiltinPresets) {
        const grp = hasMyPresetsApi ? document.createElement('optgroup') : null;
        if (grp) {
          grp.label = 'Built-in';
          select.append(grp);
        }
        for (const p of model.presets) (grp ?? select).append(new Option(p, `builtin:${p}`));
      }
      if (myPresetNames.length > 0) {
        const grp = document.createElement('optgroup');
        grp.label = 'My presets';
        for (const p of myPresetNames) grp.append(new Option(p, `user:${p}`));
        select.append(grp);
      }
    }
    fillOptions();
    select.addEventListener('change', () => {
      const [kind, ...rest] = select.value.split(':');
      const name = rest.join(':');
      if (kind === 'builtin') model.onPresetPick?.(name);
      else if (kind === 'user') model.applyMyPreset?.(name);
      select.value = '';
    });
    presetRow.append(select);
    if (hasMyPresetsApi) {
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.textContent = '💾';
      saveBtn.title = 'Save the current settings as a named preset, shared with the whole table.';
      Object.assign(saveBtn.style, { flex: '0 0 auto', padding: '2px 6px', fontSize: '.72rem', cursor: 'pointer' });
      saveBtn.addEventListener('click', async () => {
        const name = window.prompt(`Save "${model.title}" settings as a preset named:`, '');
        if (!name || !name.trim()) return;
        const res = await model.saveMyPreset?.(name.trim());
        if (res && !res.ok) window.alert(`Couldn't save preset: ${res.reason}`);
        else model.onRequestRerender?.();
      });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '🗑';
      delBtn.title = 'Delete the selected "My presets" entry (built-in presets can\'t be deleted here).';
      Object.assign(delBtn.style, { flex: '0 0 auto', padding: '2px 6px', fontSize: '.72rem', cursor: 'pointer' });
      delBtn.addEventListener('click', async () => {
        const [kind, ...rest] = select.value.split(':');
        const name = rest.join(':');
        if (kind !== 'user' || !name) {
          window.alert('Pick one of "My presets" from the dropdown first — built-in presets can\'t be deleted here.');
          return;
        }
        if (!window.confirm(`Delete the preset "${name}"?`)) return;
        await model.deleteMyPreset?.(name);
        model.onRequestRerender?.();
      });
      presetRow.append(saveBtn, delBtn);
    }
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
/** In-grid search query (mythica-machina-press#548) — module-level so it
 * survives a chip click's full re-render, same posture as `activeFilter`.
 * Deliberately separate from search-palette.js's own global overlay: that
 * one jumps OUT to a flat cross-effect result list (finds one param
 * anywhere); this filters the grid IN PLACE (finds which whole cards are
 * relevant), a different question with a different answer shape. */
let searchQuery = '';

/**
 * Does this card match a search query? Same plain-substring convention
 * search-palette.js's own header documents as the validated, non-fuzzy
 * behaviour (label+title+help) — applied here at the CARD level (title, or
 * any one of its params' label/help/category) rather than the param level,
 * since this filters whole cards, not individual rows.
 * @param {EffectCardModel} model @param {string} ql - already lowercased/trimmed.
 * @returns {boolean}
 */
function cardMatchesSearch(model, ql) {
  if (!ql) return true;
  if ((model.title ?? model.id ?? '').toLowerCase().includes(ql)) return true;
  for (const decl of Object.values(model.schema ?? {})) {
    const hay = `${decl.label ?? ''} ${decl.help ?? ''} ${decl.category ?? ''}`.toLowerCase();
    if (hay.includes(ql)) return true;
  }
  return false;
}

/**
 * Render the EFFECTS department body into `container` (a `.deptscroll`).
 * @param {HTMLElement} container
 * @param {{effectCardFactories: Map<string, () => EffectCardModel>,
 *   getPinnedEffects?: () => string[], setPinnedEffects?: (ids: string[]) => void}} ctx
 * @returns {string} the department subtitle for the shell's deptHead.
 */
export function renderEffectsDepartment(container, ctx) {
  if (!pinnedSeeded) {
    pinnedSeeded = true;
    for (const id of ctx.getPinnedEffects?.() ?? []) pinned.add(id);
  }
  const models = [...ctx.effectCardFactories.entries()].map(([id, factory]) => ({ id, model: factory() }));

  const strip = document.createElement('div');
  Object.assign(strip.style, { display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '12px' });
  const grid = document.createElement('div');
  Object.assign(grid.style, {
    display: 'grid',
    // Fixed at exactly two columns (mythica-machina-press#548) — the previous
    // auto-fill(minmax(320px,...)) happily packed in a 3rd column on any wide
    // Studio window, which is what made the header-overlap bug (see
    // buildStudioEffectCard's `name` span below) bite in practice: three
    // columns left too little width per card for the badge/tool cluster.
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '12px',
    alignContent: 'start',
    // Grid items default to `align-items:stretch` — confirmed live in the
    // Studio preview harness: opening Water's 54-control Advanced section
    // stretched its ROW-1 neighbour (Bloom, one slider) to match Water's
    // full ~1700px height, leaving a huge empty pink-bordered box under
    // Bloom's single control. Each card should size to its OWN content.
    alignItems: 'start',
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

  // IN-GRID SEARCH (mythica-machina-press#548) — filters the ALREADY
  // category-filtered grid live, without a full re-render (which would
  // rebuild this very input and drop keyboard focus after every character —
  // confirmed by reading how this department commits to the DOM,
  // `container.innerHTML = ''` on every render, below). Toggles `.hidden`
  // on the already-built card elements instead.
  // Wrapped with its own icon (mythica-machina-press#548) so it visually
  // reads as a lighter-weight, secondary "filter what's on screen" control —
  // distinct from the room-header's pill-shaped, kbd-hinted global search box
  // right above it, which is a different action (jump to one control anywhere
  // in the Studio) even though the two sat close enough to look redundant.
  const searchWrap = document.createElement('div');
  Object.assign(searchWrap.style, {
    flexBasis: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    background: 'var(--bg2)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--r-ctl,6px)',
    padding: '4px 10px',
  });
  const searchIcon = document.createElement('span');
  Object.assign(searchIcon.style, { display: 'flex', flex: '0 0 auto', color: 'var(--ink2)' });
  searchIcon.innerHTML = iconMarkup('search', 'style="width:12px;height:12px"');
  const searchBox = document.createElement('input');
  searchBox.type = 'search';
  searchBox.placeholder = 'Filter the cards below by name or control…';
  searchBox.value = searchQuery;
  searchBox.setAttribute('aria-label', 'Filter effects in this category');
  Object.assign(searchBox.style, {
    flex: '1',
    minWidth: '0',
    background: 'none',
    border: 'none',
    outline: 'none',
    color: 'var(--ink0)',
    fontSize: '.74rem',
  });
  searchWrap.append(searchIcon, searchBox);
  strip.append(searchWrap);

  const visible = models
    .filter(({ model }) => !activeFilter || model.filterCategory === activeFilter)
    .filter(({ id }) => !poppedOut.has(id))
    .sort((a, b) => (pinned.has(b.id) ? 1 : 0) - (pinned.has(a.id) ? 1 : 0));
  // Persisted every render (cheap, idempotent when nothing changed) rather
  // than threading ctx into buildStudioEffectCard's own pin-button handler
  // just to call this in one more place — a filter-chip click re-persisting
  // the same array is harmless.
  ctx.setPinnedEffects?.([...pinned]);
  /** @type {Array<{model: EffectCardModel, el: HTMLElement}>} */
  const cardEls = [];
  for (const { id, model } of visible) {
    model.onRequestRerender = () => renderEffectsDepartment(container, ctx);
    // MY PRESETS (mythica-machina-press#102) — thin per-model bindings onto
    // ctx's generic (any effectId) preset API, same "attach what the card
    // needs onto model itself" shape onRequestRerender just above already
    // uses. Omitted (ctx doesn't supply them) ⇒ `hasMyPresetsApi` above is
    // false and the whole UI section for this simply doesn't render.
    if (typeof ctx.listEffectPresets === 'function') {
      model.listMyPresets = () => ctx.listEffectPresets(id);
      model.saveMyPreset = (name) => ctx.saveEffectPreset(id, name);
      model.applyMyPreset = (name) => ctx.applyEffectPreset(id, name);
      model.deleteMyPreset = (name) => ctx.deleteEffectPreset(id, name);
    }
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
    const cardEl = buildStudioEffectCard(model);
    cardEls.push({ model, el: cardEl });
    grid.append(cardEl);
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
  // Search-only empty state — distinct from the category one above, since
  // the category empty state renders INSTEAD of cards (no cardEls to
  // toggle), while this one hides ALREADY-BUILT cards live.
  const noSearchMatch = document.createElement('div');
  noSearchMatch.hidden = true;
  noSearchMatch.style.cssText = 'color:var(--ink2); font-size:.8rem; padding:20px';
  noSearchMatch.textContent = 'Nothing in this category matches your search.';
  grid.append(noSearchMatch);

  /** Apply `query` live to the already-built cards — no re-render, so the
   * search box itself never loses focus mid-type. Re-run on every render
   * too (a chip click rebuilds the grid from scratch), so an active search
   * survives switching categories. */
  function applySearchFilter(query) {
    searchQuery = (query ?? '').trim().toLowerCase();
    let anyVisible = false;
    for (const { model, el } of cardEls) {
      const match = cardMatchesSearch(model, searchQuery);
      el.hidden = !match;
      if (match) anyVisible = true;
    }
    noSearchMatch.hidden = cardEls.length === 0 || anyVisible;
  }
  searchBox.addEventListener('input', () => applySearchFilter(searchBox.value));
  applySearchFilter(searchQuery);

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
