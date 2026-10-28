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
import { buildArmButton, buildNameComposer } from '../../widgets/inline-actions.js';
import { DIAL_DRIVE_TYPES } from '../../../core/dials-schema.js';
import { groupOf, groupEffects } from './effect-catalog.js';

/*
 * THE LIBRARY AND THE ONE OPEN EFFECT (2026-10-28, author: "I'm never editing
 * two effects at the same time, how can we use that fact to make a better UX").
 * The department is in one of two views: the LIBRARY (every effect as a small
 * tile, in the groups `effect-catalog.js` defines) or ONE effect's editor,
 * filling the pane. It used to draw all ~30 cards fully open in one column,
 * which is what pins, pop-outs, category chips and per-card "Advanced" folds
 * were all working around; they went with it.
 *
 * Module state, not DOM state: every action rebuilds the department, and the
 * Studio closing must not forget which effect was open. `openEffect` and
 * `recent` also persist per GM through ctx.getEffectsMemory/setEffectsMemory.
 */
/** The effect whose editor is showing, or null for the library. */
let openEffect = null;
/** Most-recently opened effect ids, newest first. */
let recent = [];
const RECENT_MAX = 4;
/** Has the memory above been seeded from ctx yet? (Once — a re-seed would undo a live click.) */
let memorySeeded = false;
/** The last memory written, so a re-render that changed nothing doesn't write the setting again. */
let lastSavedMemory = '';
/** The library's filter box and its "On only" chip. */
let libraryQuery = '';
let onlyOn = false;
/** Where the library was scrolled to, so "back" lands where the GM left it. */
let libraryScroll = 0;
/** Card ids whose "my presets" list is expanded — survives the rebuild every action causes. */
const presetManagerOpen = new Set();
/** Card id -> the enable state its card was last DRAWN in. Lets a re-render
 * draw the switch in its previous state and flip it a frame later, so the
 * thumb actually slides instead of teleporting (see buildStudioEffectCard). */
const lastEnabled = new Map();

/** Note `effectId` as the newest recent effect. */
function touchRecent(effectId) {
  recent = [effectId, ...recent.filter((id) => id !== effectId)].slice(0, RECENT_MAX);
}

function sectionLabel(text) {
  const el = document.createElement('div');
  el.className = 'msa-sec';
  el.textContent = text;
  return el;
}

/** Tiny element factory — the card is built from a lot of small boxes. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A `.hbtn` icon button. `title` is the tooltip (it can be a whole sentence);
 * `label` is the SHORT accessible name a screen reader announces. */
function iconButton(icon, title, extraClass = '', label = title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `hbtn${extraClass ? ` ${extraClass}` : ''}`;
  b.title = title;
  b.setAttribute('aria-label', label);
  b.innerHTML = iconMarkup(icon);
  return b;
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
 * The copy button every OLD debug-panel card already has
 * (`diag/effect-controls.js#buildCopyButton`) — never ported to this shell
 * until now (mythica-machina-press#490). It used to be the literal 📋 glyph
 * that swapped its own TEXT to "✓ Copied": a colour emoji that ignored the
 * theme, and a button that changed WIDTH mid-click and shoved its neighbours
 * along the row. Now three stacked icons (copy / check / x) in a fixed 24px
 * button; the state change is a cross-fade with a touch of blur (two distinct
 * icons overlapping reads as two objects — blur makes it read as one thing
 * turning into another) and nothing moves.
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
  const idleTitle = 'Copy every current setting for this effect as text — paste it to Claude instead of a screenshot.';
  const idleLabel = 'Copy settings';
  const btn = iconButton('copy', idleTitle, 'msa-copy', idleLabel);
  btn.dataset.state = 'idle';
  btn.innerHTML =
    `<span class="msa-swap"><span class="msa-swap-i" data-for="idle">${iconMarkup('copy')}</span>` +
    `<span class="msa-swap-i" data-for="done">${iconMarkup('check')}</span>` +
    `<span class="msa-swap-i" data-for="fail">${iconMarkup('x')}</span></span>`;
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
    btn.dataset.state = ok ? 'done' : 'fail';
    btn.setAttribute('aria-label', ok ? 'Copied' : 'Copy failed');
    resetTimer = setTimeout(() => {
      btn.dataset.state = 'idle';
      btn.setAttribute('aria-label', idleLabel);
    }, 1400);
  });
  return btn;
}

/**
 * Replay every schema key's own declared default through `model.onChange` —
 * the exact path a GM dragging each slider back by hand would take.
 * `onChange` already owns the liveOverride write, the scene-flag write, and
 * the reapply (see e.g. `water-registration.js#setWater`), so resetting
 * needs no persistence of its own, just enough calls to put every param back
 * where its own schema says it starts. `action` params (buttons, not values)
 * and any decl missing its own required `default` (should not happen —
 * `validateParamsSchema` already refuses that at build time) are skipped.
 * @param {EffectCardModel} model
 */
function resetModelToDefaults(model) {
  if (!model?.schema || typeof model.onChange !== 'function') return;
  for (const [key, decl] of Object.entries(model.schema)) {
    if (!decl || decl.type === 'action' || !('default' in decl)) continue;
    model.onChange(key, decl.default);
  }
  model.onRequestRerender?.();
}

/**
 * Does this model have at least one real (non-action) param to reset? Same
 * guard `buildCopySettingsButton`'s own call site uses — a card with nothing
 * to copy has nothing to reset either.
 * @param {EffectCardModel} model
 */
function hasResettableParams(model) {
  return Object.values(model?.schema ?? {}).some((d) => d && d.type !== 'action' && 'default' in d);
}

/**
 * The per-card "reset to defaults" button — two-click armed, same posture as
 * a preset delete (`buildArmButton`, see the trash button in `buildPresetRow`):
 * putting back every control a GM may have spent real time hand-tuning is
 * exactly the kind of thing a stray click must not do.
 * @param {object} model @returns {HTMLElement}
 */
function buildResetDefaultsButton(model) {
  const name = model.title ?? model.id;
  return buildArmButton({
    icon: 'reset',
    armedLabel: 'Reset?',
    title: `Reset ${name} to its default values`,
    armedTitle: `Click again to reset ${name} to its defaults`,
    className: 'hbtn',
    onConfirm: () => resetModelToDefaults(model),
  });
}

/**
 * The PRESET row: pick one to apply it, save the current look under a name,
 * and manage (delete) your own.
 *
 * Replaces three native dialogs (`prompt` to name, `confirm` to delete, `alert`
 * for every failure) that each froze the whole tab — and with it the live map
 * — behind a grey OS box. Naming is now an inline field that opens in the row,
 * deleting is a two-click confirm on the item, and failures are a line of
 * text under the row.
 *
 * ⚠️ DELETE USED TO BE UNREACHABLE. The old trash button read the dropdown's
 * selected value, but picking a preset APPLIES it and then resets the dropdown
 * to "— preset —" in the same handler, so by the time the button was clicked
 * the selection was always empty and it could only ever say "pick one first".
 * Deleting now lives on a small list of your own presets, each with its own
 * trash button, so it no longer depends on dropdown state at all.
 * @param {object} model @returns {HTMLElement}
 */
function buildPresetRow(model) {
  const hasBuiltinPresets = Array.isArray(model.presets) && model.presets.length > 0;
  const hasMyPresetsApi = typeof model.listMyPresets === 'function';
  const wrap = el('div', 'msa-presetwrap');
  const row = el('div', 'msa-presetrow');
  const status = el('p', 'msa-status');
  status.setAttribute('role', 'status');
  status.hidden = true;
  const say = (text, tone) => {
    status.textContent = text ?? '';
    status.dataset.tone = tone ?? '';
    status.hidden = !text;
  };

  const select = el('select', 'msa-select');
  select.setAttribute('aria-label', `${model.title ?? model.id} preset`);
  const myPresetNames = hasMyPresetsApi ? model.listMyPresets() : [];
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
  select.addEventListener('change', async () => {
    const [kind, ...rest] = select.value.split(':');
    const name = rest.join(':');
    select.value = '';
    if (kind === 'builtin') {
      model.onPresetPick?.(name);
      // The write settles through a Promise chain (same as the enable switch);
      // the next frame is the earliest redraw that reads the settled values, so
      // the sliders show what the preset just did instead of what they held.
      requestAnimationFrame(() => model.onRequestRerender?.());
    } else if (kind === 'user') {
      const res = await model.applyMyPreset?.(name);
      if (res && !res.ok) say(`Couldn't apply "${name}": ${res.reason}`, 'fail');
      else model.onRequestRerender?.();
    }
  });
  row.append(select);

  if (hasMyPresetsApi) {
    const saveBtn = iconButton(
      'save',
      'Save the current settings as a named preset, shared with the whole table.',
      '',
      'Save as preset'
    );
    const manageBtn = iconButton('trash', 'Manage my presets');
    manageBtn.setAttribute('aria-expanded', String(presetManagerOpen.has(model.id)));
    manageBtn.disabled = myPresetNames.length === 0;
    if (myPresetNames.length === 0) manageBtn.title = 'No presets of your own to manage yet';

    const list = el('div', 'msa-presetlist');
    list.hidden = !(presetManagerOpen.has(model.id) && myPresetNames.length > 0);
    for (const name of myPresetNames) {
      const item = el('div', 'msa-presetitem');
      const label = el('span', 'msa-presetitem-name', name);
      label.dataset.tip = name;
      label.dataset.tipTruncated = '';
      const del = buildArmButton({
        icon: 'trash',
        armedLabel: 'Delete?',
        title: `Delete "${name}" for everyone at the table`,
        armedTitle: `Click again to delete "${name}"`,
        className: 'hbtn',
        onConfirm: async () => {
          const res = await model.deleteMyPreset?.(name);
          if (res && !res.ok) say(`Couldn't delete "${name}": ${res.reason}`, 'fail');
          else model.onRequestRerender?.();
        },
      });
      item.append(label, del);
      list.append(item);
    }
    manageBtn.addEventListener('click', () => {
      const open = list.hidden;
      list.hidden = !open;
      manageBtn.setAttribute('aria-expanded', String(open));
      if (open) presetManagerOpen.add(model.id);
      else presetManagerOpen.delete(model.id);
    });

    saveBtn.addEventListener('click', () => {
      const keep = [...row.childNodes];
      const restore = () => row.replaceChildren(...keep);
      const composer = buildNameComposer({
        placeholder: 'Preset name',
        ariaLabel: `Name for the new ${model.title ?? model.id} preset`,
        submitLabel: 'Save',
        onCancel: restore,
        onSubmit: async (name) => {
          const res = await model.saveMyPreset?.(name);
          if (res && !res.ok) {
            restore();
            say(`Couldn't save preset: ${res.reason}`, 'fail');
          } else {
            model.onRequestRerender?.();
          }
        },
      });
      row.replaceChildren(composer.el);
      composer.focus();
    });
    row.append(saveBtn, manageBtn);
    wrap.append(row, list, status);
  } else {
    wrap.append(row, status);
  }
  return wrap;
}

/**
 * One effect's card. `model` is read FRESH each call (never cached — the
 * whole grid rebuilds on every render, same discipline as the mock's own
 * `renderDept`), so `getValue`/`getEnabled` inside it are the live accessors
 * the caller's `modelFactory` returns, not a snapshot.
 * @param {object} model - see effects-department's own JSDoc typedef below.
 * @param {{groupLabel: string, onBack: () => void, onPrev?: () => void, onNext?: () => void}} nav -
 *   the editor's way back to the library and along its group.
 * @returns {HTMLElement}
 */
function buildStudioEffectCard(model, nav) {
  const accVar = model.accVar ?? '--shine';
  const isOn = model.enabled !== false;

  const card = el('article', 'msa-card');
  card.dataset.msaEffect = model.id;
  card.style.setProperty('--acc', `var(${accVar})`);

  // ⚠️ THE CARD IS BUILT ONE STEP BEHIND, THEN FLIPPED. Every action on the page
  // re-renders the whole grid, so the switch a user just clicked is a brand-new
  // element — and a freshly inserted element has no "before" for a CSS
  // transition to run from, so the thumb used to teleport. Remember the state
  // each card was last drawn in; if it differs now, draw it in the OLD state
  // first and flip it two frames later (one to let the browser commit the old
  // style, one to be safe). Unchanged state (every other re-render) draws
  // straight in, with no motion.
  const wasOn = lastEnabled.has(model.id) ? lastEnabled.get(model.id) : isOn;
  lastEnabled.set(model.id, isOn);
  card.dataset.enabled = String(wasOn);
  let enableSwitch = null;

  // ---- header: two rows (mythica-machina-press#548) ------------------------
  // Row 1 is IDENTITY (icon + title + enable) and nothing else; row 2 is
  // META + TOOLS (health/tier/scope badges, then pin/popout/paint/copy).
  // The old single-row header packed up to ten flex children onto one line —
  // on any card with a longer title (Candle flame, Lightning, Precipitation)
  // plus its full badge/tool set, the title's own box was only a few px wide
  // and its overflowing tail was painted over by whatever followed it. Two
  // rows means row 1 only ever has three children fighting for width, and the
  // title genuinely truncates (ellipsis) instead of spilling into its neighbour.
  const head = el('div', 'msa-card-head');
  const headTop = el('div', 'msa-card-top');
  const back = iconButton('chev', 'Back to all effects (Esc)', 'msa-back', 'All effects');
  back.addEventListener('click', nav.onBack);
  headTop.append(back);
  const ic = el('span', 'msa-card-ico');
  ic.innerHTML = iconMarkup(model.icon ?? 'gear');
  const nameWrap = el('span', 'msa-card-names');
  const name = el('span', 'msa-card-title', model.title);
  // Only worth a tooltip when the name is actually cut off — the tooltip
  // widget checks that at hover time (`data-tip-truncated`).
  name.dataset.tip = model.title ?? '';
  name.dataset.tipTruncated = '';
  const statusText =
    typeof model.status === 'function'
      ? model.status()
      : (model.status ?? collapsedStatusLine({ enabled: model.enabled }));
  const statusLine = el('span', 'msa-card-status', statusText);
  if (statusText) {
    statusLine.dataset.tip = statusText;
    statusLine.dataset.tipTruncated = '';
  }
  const crumb = el('span', 'msa-card-crumb', nav.groupLabel);
  nameWrap.append(crumb, name, statusLine);
  headTop.append(ic, nameWrap);
  // Step through the effect's own group without going back to the library.
  if (nav.onPrev && nav.onNext) {
    const prev = iconButton('chev', 'Previous effect in this group', 'msa-prev', 'Previous effect');
    const next = iconButton('chev', 'Next effect in this group', 'msa-next', 'Next effect');
    prev.addEventListener('click', nav.onPrev);
    next.addEventListener('click', nav.onNext);
    headTop.append(prev, next);
  }

  if (typeof model.onToggleEnabled === 'function') {
    // A real track+thumb switch (mythica-machina-press#550) — the old control
    // was a bare 9px status dot, indistinguishable from the badges beside it.
    // `model.enabled === false` is the one explicit "off" case — undefined
    // reads as on, same default as everywhere else.
    enableSwitch = el('button', 'msa-switch');
    enableSwitch.type = 'button';
    enableSwitch.setAttribute('role', 'switch');
    enableSwitch.setAttribute('aria-checked', String(wasOn));
    enableSwitch.setAttribute('aria-label', `${model.title ?? model.id} enabled`);
    enableSwitch.title = isOn ? 'Enabled — click to turn off' : 'Disabled — click to turn on';
    enableSwitch.addEventListener('click', () => {
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
    headTop.append(enableSwitch);
  }
  if (wasOn !== isOn) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        card.dataset.enabled = String(isOn);
        enableSwitch?.setAttribute('aria-checked', String(isOn));
      })
    );
  }
  head.append(headTop);

  // ---- row 2: health/tier/scope badges, then pin/popout/paint/copy ----
  const headMeta = el('div', 'msa-card-meta');
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
  headMeta.append(el('span', 'msa-grow'));

  if (typeof model.onPaint === 'function') {
    // `paintVerb` (2026-08-19, effects-population round) -- most onPaint
    // hooks open the mask brush ("Paint X"), but candle/lightning have no
    // mask at all: their onPaint opens click-to-place ANCHOR mode instead.
    // Defaults to the original wording so every already-shipped card (water
    // included) is unaffected.
    const paintBtn = iconButton('brush', `${model.paintVerb ?? 'Paint'} ${model.title} on the map`);
    paintBtn.addEventListener('click', () => model.onPaint());
    headMeta.append(paintBtn);
  }
  // The copy-settings button — see `buildCopySettingsButton`'s own note.
  // Same "skip when there's nothing to copy" guard `buildEffectCard` uses.
  if (model.schema && Object.keys(model.schema).length > 0) {
    headMeta.append(buildCopySettingsButton(model));
  }
  // The per-card "reset to defaults" button (2026-10-24, on the author's own
  // ask: a well-placed, obvious way to put one effect's tuning back to
  // normal). Same guard as copy-settings just above, narrowed to real
  // (non-action) params — a card made entirely of buttons has nothing a
  // default value could mean.
  if (hasResettableParams(model)) {
    headMeta.append(buildResetDefaultsButton(model));
  }
  head.append(headMeta);
  card.append(head);

  // ---- mask-found/missing row ----------------------------------------------
  if (model.mask) {
    const row = el('div', 'msa-maskrow');
    row.dataset.found = String(!!model.mask.found);
    row.innerHTML = model.mask.found
      ? `${iconMarkup('check')} <code>${model.mask.suffix}</code> mask found`
      : `${iconMarkup('warn')} Needs a <code>${model.mask.suffix}</code> mask`;
    if (!model.mask.found && typeof model.onPaint === 'function') {
      const paintLink = el('button', 'msa-link msa-inline-paint', 'Paint one');
      paintLink.type = 'button';
      paintLink.addEventListener('click', () => model.onPaint());
      row.append(paintLink);
    }
    card.append(row);
  }

  // ---- jump bar: one chip per section, filled in once the sections exist ----
  // Sticky under the editor's top edge, so on a long effect (Water has 54
  // controls) any section is one press away wherever the GM has scrolled to.
  const jump = el('nav', 'msa-jump');
  jump.setAttribute('aria-label', 'Jump to section');
  card.append(jump);
  /** @type {Array<{label: string, el: HTMLElement}>} */
  const sections = [];

  // ---- FOH strip: presets (if any) + fohKeys --------------------------------
  const foh = el('div', 'msa-foh');
  sections.push({ label: 'Main', el: foh });
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
  // this deletes from at all. (Built in `buildPresetRow` above.)
  if (hasBuiltinPresets || typeof model.listMyPresets === 'function') foh.append(buildPresetRow(model));
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
    // A dial can only drive a float/int param (`core/dials-schema.js`'s own
    // positive gate, `DIAL_DRIVE_TYPES`) — an `angle`/`color`/etc `fohKeys`
    // entry has no dial FORM at all, so skipping it here would strand it:
    // `rohGroups` below treats every `fohKeys` entry as promoted regardless
    // of whether a dial actually covers it, so it would vanish from Advanced
    // too and end up with no live control anywhere. CAUGHT LIVE 2026-09-17 —
    // water's own `flowAngleDeg` ("Set direction in Advanced" the Flow
    // dial's help text promises had nowhere to land; the compass-dial widget
    // `param-control.js#buildCompassRow` was built for exactly this control
    // back when it was first requested, 2026-08-16, but never reached the
    // Studio card once dials replaced the raw `fohKeys` strip). Render those
    // as raw controls, appended after the dials — a `float`/`int` fohKey
    // that a dial simply doesn't cover (a deliberate ROH-only demotion, e.g.
    // water's own `opacity`) is a DIFFERENT case and stays excluded here.
    for (const key of model.fohKeys ?? []) {
      const decl = model.schema?.[key];
      if (!decl || DIAL_DRIVE_TYPES.includes(decl.type)) continue;
      const row = buildParamControl(key, decl, { value: model.getValue(key), onChange: (v) => model.onChange(key, v) });
      row.dataset.msaParam = key;
      row.classList.add('msa-param-row');
      foh.append(row);
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
  for (const extraEl of resolveExtra(model.extra)) card.append(extraEl);

  // ---- the rest of the controls, as open sections ---------------------------
  // These sat in a closed "Advanced" fold while ~30 cards shared one column.
  // With one effect on screen there is room for all of them, so each schema
  // category is its own labelled section, reachable from the jump bar.
  const roh = rohGroups(model.schema, model.fohKeys);
  for (const { category, keys } of roh) {
    const section = el('section', 'msa-section');
    section.append(sectionLabel(category));
    const wrap = el('div', 'msa-section-body');
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
    section.append(wrap);
    card.append(section);
    sections.push({ label: category, el: section });
  }
  // Opaque advanced-only content (specular's 3 shimmer-layer strips is the
  // canonical case — see diag/effect-controls.js's own JSDoc), after the
  // categorised sections, same position the old shell used.
  const extraAdvanced = resolveExtra(model.extraAdvanced);
  if (extraAdvanced.length > 0) {
    const section = el('section', 'msa-section');
    section.append(sectionLabel('More'), ...extraAdvanced);
    card.append(section);
    sections.push({ label: 'More', el: section });
  }

  // Worth a bar only once there is somewhere to jump to.
  if (sections.length >= 3) {
    for (const { label, el: target } of sections) {
      const chip = el('button', 'msa-chip', label);
      chip.type = 'button';
      chip.addEventListener('click', () => target.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      jump.append(chip);
    }
  } else {
    jump.remove();
  }

  return card;
}

/**
 * @typedef {object} EffectCardModel
 * @property {string} id @property {string} title @property {string} [icon]
 * @property {string} [accVar] - a LANTERN category token name, e.g. '--c-atmos';
 *   defaults to the effect's catalog group's own (see effect-catalog.js, which
 *   is also what decides the group — a card no longer names its category).
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
 * @property {()=>void} [onPaint]
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
 * Make sure the next render shows the effect the search palette wants, before
 * it goes looking for the control. Called by shell.js on every "go to this
 * control".
 *
 * ⚠️ SEARCH USED TO DO NOTHING. The grid's category chip and card filter were
 * module state that outlived the Studio closing, and the palette only ever
 * looked in the grid as drawn — so once a GM had clicked, say, "Post", picking
 * any Water or Fireflies result closed the palette and silently went nowhere.
 * Now the palette names the effect it wants and that effect's editor opens.
 * @param {string} effectId
 */
export function revealEffectCard(effectId) {
  openEffect = effectId;
  touchRecent(effectId);
}

/**
 * Does this effect match the library's filter? Plain lowercase substring, the
 * same convention search-palette.js documents: the effect's title, or any one
 * of its params' label/help/category.
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
 * Render the EFFECTS department body into `container` (a `.deptscroll`): the
 * library, or the one open effect.
 * @param {HTMLElement} container
 * @param {{effectCardFactories: Map<string, () => EffectCardModel>,
 *   getEffectsMemory?: () => {open: string|null, recent: string[]},
 *   setEffectsMemory?: (memory: {open: string|null, recent: string[]}) => void}} ctx
 * @returns {string} the department subtitle for the shell's deptHead.
 */
export function renderEffectsDepartment(container, ctx) {
  if (!memorySeeded) {
    memorySeeded = true;
    const saved = ctx.getEffectsMemory?.();
    if (saved) {
      // A search that opened an effect before the first render has already set these.
      openEffect ??= saved.open ?? null;
      if (recent.length === 0) recent = [...(saved.recent ?? [])];
    }
  }
  // An effect that is no longer registered (a module turned off) falls back to the library.
  if (openEffect && !ctx.effectCardFactories.has(openEffect)) openEffect = null;
  recent = recent.filter((id) => ctx.effectCardFactories.has(id));

  const memory = JSON.stringify({ open: openEffect, recent });
  if (memory !== lastSavedMemory) {
    lastSavedMemory = memory;
    ctx.setEffectsMemory?.({ open: openEffect, recent: [...recent] });
  }

  const rerender = () => renderEffectsDepartment(container, ctx);
  /** Switch view, keeping the library's scroll and starting an effect at its top. */
  const show = (effectId) => {
    if (openEffect === null) libraryScroll = container.scrollTop;
    openEffect = effectId;
    if (effectId) touchRecent(effectId);
    rerender();
    container.scrollTop = effectId ? 0 : libraryScroll;
  };

  // Esc goes back to the library — attached once per container (the shell
  // builds a fresh one each time it renders a department), never in a field,
  // where Esc belongs to the field.
  if (!container.dataset.msaEsc) {
    container.dataset.msaEsc = '1';
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || openEffect === null) return;
      if (e.target instanceof Element && e.target.matches('input,select,textarea')) return;
      e.preventDefault();
      show(null);
    });
  }

  const subtitle = openEffect
    ? renderEditor(container, ctx, show, rerender)
    : renderLibrary(container, ctx, show, rerender);
  // Switching views re-renders only this department, not the shell's header
  // above it, so keep that header's subtitle in step here.
  const sub = container.parentElement?.querySelector('.depthead .sub');
  if (sub) {
    sub.textContent = subtitle;
    sub.dataset.tip = subtitle;
  }
  return subtitle;
}

/**
 * One effect, filling the department.
 * @param {HTMLElement} container @param {object} ctx
 * @param {(effectId: string|null) => void} show @param {() => void} rerender
 * @returns {string} subtitle
 */
function renderEditor(container, ctx, show, rerender) {
  const id = openEffect;
  const model = ctx.effectCardFactories.get(id)();
  model.onRequestRerender = rerender;
  decorateModel(model, id, ctx);

  const group = groupOf(id);
  const siblings = groupEffects([...ctx.effectCardFactories.keys()]).find((g) => g.group === group)?.ids ?? [id];
  const at = siblings.indexOf(id);
  const step = (by) => show(siblings[(at + by + siblings.length) % siblings.length]);
  model.accVar ??= group.accVar;
  const card = buildStudioEffectCard(model, {
    groupLabel: group.label,
    onBack: () => show(null),
    ...(siblings.length > 1 ? { onPrev: () => step(-1), onNext: () => step(1) } : {}),
  });
  card.classList.add('msa-card--open');

  container.innerHTML = '';
  container.append(card);
  return `${group.label} — ${at + 1} of ${siblings.length}`;
}

/**
 * The library: every registered effect as a small tile, in its catalog group.
 * @param {HTMLElement} container @param {object} ctx
 * @param {(effectId: string|null) => void} show @param {() => void} rerender
 * @returns {string} subtitle
 */
function renderLibrary(container, ctx, show, rerender) {
  const models = new Map();
  for (const [id, factory] of ctx.effectCardFactories) {
    const model = factory();
    model.onRequestRerender = rerender;
    models.set(id, model);
  }
  const grouped = groupEffects([...models.keys()]);

  // ---- toolbar: filter box + "On only" ---------------------------------------
  // The filter hides tiles in place, without a re-render (which would rebuild
  // this very input and drop focus after every character).
  const bar = el('div', 'msa-libbar');
  const field = el('div', 'msa-field');
  field.innerHTML = iconMarkup('search');
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Find an effect or a control…';
  input.value = libraryQuery;
  input.setAttribute('aria-label', 'Find an effect');
  field.append(input);
  const onChip = el('button', 'msa-chip', 'On only');
  onChip.type = 'button';
  onChip.title = 'Show only the effects that are switched on';
  onChip.setAttribute('aria-pressed', String(onlyOn));
  onChip.addEventListener('click', () => {
    onlyOn = !onlyOn;
    rerender();
  });
  bar.append(field, onChip);

  /** @type {Array<{id: string, tile: HTMLElement}>} */
  const tiles = [];
  const makeTile = (id) => {
    const tile = buildEffectTile(id, models.get(id), () => show(id));
    tiles.push({ id, tile });
    return tile;
  };

  const body = el('div', 'msa-lib');
  // ---- recent ------------------------------------------------------------------
  const recentIds = recent.filter((id) => models.has(id));
  const recentBlock = el('div', 'msa-libgroup msa-libgroup--recent');
  if (recentIds.length > 0) {
    const head = el('div', 'msa-libhead');
    head.innerHTML = iconMarkup('clock');
    head.append(el('span', 'msa-libhead-name', 'Recent'));
    const grid = el('div', 'msa-libgrid');
    for (const id of recentIds) grid.append(buildEffectTile(id, models.get(id), () => show(id)));
    recentBlock.append(head, grid);
    body.append(recentBlock);
  }

  // ---- the groups ----------------------------------------------------------------
  /** @type {Array<{block: HTMLElement, ids: string[]}>} */
  const groupBlocks = [];
  for (const { group, ids } of grouped) {
    const block = el('div', 'msa-libgroup');
    block.style.setProperty('--acc', `var(${group.accVar})`);
    const head = el('div', 'msa-libhead');
    head.innerHTML = iconMarkup(group.icon);
    const onCount = ids.filter((id) => models.get(id).enabled !== false).length;
    head.append(
      el('span', 'msa-libhead-name', group.label),
      el('span', 'msa-libhead-count', `${onCount} of ${ids.length} on`)
    );
    const grid = el('div', 'msa-libgrid');
    for (const id of ids) {
      const tile = makeTile(id);
      tile.style.setProperty('--acc', `var(${models.get(id).accVar ?? group.accVar})`);
      grid.append(tile);
    }
    block.append(head, grid);
    body.append(block);
    groupBlocks.push({ block, ids });
  }
  const noMatch = el('div', 'msa-empty', models.size === 0 ? 'No effects registered yet.' : 'No effect matches that.');
  body.append(noMatch);

  /** Apply the filter box and "On only" to the tiles already built. */
  function applyFilter() {
    libraryQuery = input.value;
    const ql = libraryQuery.trim().toLowerCase();
    const shown = new Set();
    for (const { id, tile } of tiles) {
      const model = models.get(id);
      const match = cardMatchesSearch(model, ql) && (!onlyOn || model.enabled !== false);
      tile.hidden = !match;
      if (match) shown.add(id);
    }
    for (const { block, ids } of groupBlocks) block.hidden = !ids.some((id) => shown.has(id));
    // Recent is a shortcut, not a result list — out of the way while filtering.
    recentBlock.hidden = Boolean(ql) || onlyOn;
    noMatch.hidden = shown.size > 0;
    return shown;
  }
  input.addEventListener('input', applyFilter);
  // Enter opens the first match: type a few letters, Enter, and you're in.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = tiles.find(({ tile }) => !tile.hidden);
    if (first) {
      e.preventDefault();
      show(first.id);
    }
  });
  applyFilter();

  // ---- reset all, at the foot: it acts on everything, so it is out of the way -
  const resettable = [...models.values()].filter((model) => hasResettableParams(model));
  const resetAllRow = el('div', 'msa-resetall');
  const resetAllBtn = buildArmButton({
    icon: 'reset',
    label: 'Reset all effects to defaults',
    armedLabel: () => `Click again to reset all ${resettable.length} effects`,
    title: "Put every registered effect's tuning on this scene back to its shipped defaults.",
    armedTitle: 'This resets EVERY effect — click again within a few seconds to confirm.',
    className: 'msa-btn',
    onConfirm: () => {
      for (const model of resettable) resetModelToDefaults(model);
      rerender();
    },
  });
  resetAllBtn.disabled = resettable.length === 0;
  resetAllRow.append(
    resetAllBtn,
    el(
      'span',
      'msa-resetall-note',
      resettable.length > 0 ? `Affects all ${resettable.length} registered effects on this scene.` : ''
    )
  );

  container.innerHTML = '';
  container.append(bar, body, resetAllRow);
  const total = models.size;
  const on = [...models.values()].filter((m) => m.enabled !== false).length;
  return `${total} effects in ${grouped.length} groups — ${on} on`;
}

/**
 * One library tile: press the name to open the effect, flip the switch to
 * turn it on or off without leaving the library. Two sibling buttons, never a
 * button inside a button.
 * @param {string} id @param {EffectCardModel} model @param {() => void} onOpen
 * @returns {HTMLElement}
 */
function buildEffectTile(id, model, onOpen) {
  const isOn = model.enabled !== false;
  const tile = el('div', 'msa-etile');
  tile.dataset.msaTile = id;
  const wasOn = lastEnabled.has(id) ? lastEnabled.get(id) : isOn;
  lastEnabled.set(id, isOn);
  tile.dataset.enabled = String(wasOn);

  const open = el('button', 'msa-etile-open');
  open.type = 'button';
  open.title = `Open ${model.title ?? id}`;
  const ic = el('span', 'msa-etile-ico');
  ic.innerHTML = iconMarkup(model.icon ?? 'gear');
  const name = el('span', 'msa-etile-name', model.title ?? id);
  name.dataset.tip = model.title ?? id;
  name.dataset.tipTruncated = '';
  open.append(ic, name);
  if (model.mask && !model.mask.found) {
    const warn = el('span', 'msa-etile-warn');
    warn.innerHTML = iconMarkup('warn');
    warn.title = `Needs a ${model.mask.suffix} mask`;
    open.append(warn);
  }
  open.addEventListener('click', onOpen);
  tile.append(open);

  if (typeof model.onToggleEnabled === 'function') {
    const sw = el('button', 'msa-switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(wasOn));
    sw.setAttribute('aria-label', `${model.title ?? id} enabled`);
    sw.title = isOn ? 'On — click to turn off' : 'Off — click to turn on';
    sw.addEventListener('click', () => {
      model.onToggleEnabled(!isOn);
      // Same settle-then-redraw timing as the card's own switch (see buildStudioEffectCard).
      requestAnimationFrame(() => model.onRequestRerender?.());
    });
    tile.append(sw);
    if (wasOn !== isOn) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          tile.dataset.enabled = String(isOn);
          sw.setAttribute('aria-checked', String(isOn));
        })
      );
    }
  }
  return tile;
}

/**
 * Attach the department-level hooks every card needs onto its model — the same
 * "attach what the card needs onto model itself" shape `onRequestRerender`
 * already uses.
 * @param {EffectCardModel} model @param {string} id @param {object} ctx
 */
function decorateModel(model, id, ctx) {
  // MY PRESETS (mythica-machina-press#102) — thin per-model bindings onto
  // ctx's generic (any effectId) preset API. Omitted (ctx doesn't supply them)
  // ⇒ the card's whole "my presets" section simply doesn't render.
  if (typeof ctx.listEffectPresets === 'function') {
    model.listMyPresets = () => ctx.listEffectPresets(id);
    model.saveMyPreset = (name) => ctx.saveEffectPreset(id, name);
    model.applyMyPreset = (name) => ctx.applyEffectPreset(id, name);
    model.deleteMyPreset = (name) => ctx.deleteEffectPreset(id, name);
  }
  // U6: the health badge's own click target — "deep-links to the Lab report"
  // (UI-Testament.md §9's own U6 checklist wording). Switches the Studio to
  // LAB, where the Control Health report boot.js registers lives; does not yet
  // auto-run that report on arrival (no stable hook into debug-panel.js's
  // rendered report list from outside it today — named as a real, small
  // follow-up in the U6 Petition, not silently claimed as full automation).
  model.onOpenHealthReport = () => ctx.switchDepartment?.('lab');
}
