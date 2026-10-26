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
import { POPOUT_CLASS } from './studio-style.js';

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
/** Card ids whose ADVANCED section is open. Module state, not DOM state: every
 * action on the page rebuilds the whole grid, which used to snap every open
 * section shut. Written by each `<details>`'s own `toggle` event. */
const advancedOpen = new Set();
/** Card ids whose "my presets" list is expanded — same reason as above. */
const presetManagerOpen = new Set();
/** Card id -> the enable state its card was last DRAWN in. Lets a re-render
 * draw the switch in its previous state and flip it a frame later, so the
 * thumb actually slides instead of teleporting (see buildStudioEffectCard). */
const lastEnabled = new Map();

/** Torn down by shell.js on Studio close. */
export function closeAllPopouts() {
  for (const win of poppedOut.values()) win.remove();
  poppedOut.clear();
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
 * @returns {HTMLElement}
 */
function buildStudioEffectCard(model) {
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
  nameWrap.append(name, statusLine);
  headTop.append(ic, nameWrap);

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

  // State-aware, like the enable switch above — a pinned card's own button
  // used to say "Pin to top" even though clicking it would UNpin; the label
  // describes what THIS click does, not just what the control is.
  const isPinned = pinned.has(model.id);
  const pinBtn = iconButton('pin', isPinned ? 'Unpin (remove from top)' : 'Pin to top');
  pinBtn.setAttribute('aria-pressed', String(isPinned));
  pinBtn.addEventListener('click', () => {
    if (pinned.has(model.id)) pinned.delete(model.id);
    else pinned.add(model.id);
    model.onRequestRerender?.();
  });
  headMeta.append(pinBtn);

  if (typeof model.onPopOut === 'function') {
    const popBtn = iconButton('popout', 'Pop out for side-by-side tuning');
    // The window grows out of the button that made it (see popOutCard).
    popBtn.addEventListener('click', () => model.onPopOut(popBtn.getBoundingClientRect()));
    headMeta.append(popBtn);
  }

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

  // ---- FOH strip: presets (if any) + fohKeys --------------------------------
  const foh = el('div', 'msa-foh');
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

  // ---- Advanced: ROH, categorised, + extraAdvanced -------------------------
  const roh = rohGroups(model.schema, model.fohKeys);
  const extraAdvanced = resolveExtra(model.extraAdvanced);
  if (roh.length > 0 || extraAdvanced.length > 0) {
    const details = el('details', 'msa-adv');
    // ⚠️ REMEMBERED ACROSS RE-RENDERS. Every action on the page rebuilds the
    // whole grid, so an Advanced section a GM had open snapped shut whenever
    // ANYTHING happened — flipping a different card's switch, pinning, picking
    // a filter. Whether each card's section is open is module state now, written
    // by the `toggle` event (which also fires for the search palette's
    // programmatic `d.open = true`).
    details.open = advancedOpen.has(model.id);
    details.addEventListener('toggle', () => {
      if (details.open) advancedOpen.add(model.id);
      else advancedOpen.delete(model.id);
    });
    const summary = el('summary', 'msa-adv-sum');
    // A `.msa-chev` span, not a `▸` baked into textContent — `<summary>`
    // already draws its OWN native disclosure triangle (suppressed via
    // studio-style.js's `summary::-webkit-details-marker` rule); before that
    // CSS existed this rendered as TWO triangles side by side. Same shape
    // diag/effect-controls.js's own `.msa-chev` already solved. An icon, so it
    // takes the theme's stroke and rotates with the open state like the rest.
    const chev = el('span', 'msa-chev');
    chev.innerHTML = iconMarkup('chev', 'style="width:11px;height:11px"');
    summary.append(chev, document.createTextNode(`Advanced — ${roh.reduce((n, g) => n + g.keys.length, 0)} controls`));
    details.append(summary);
    const body = el('div', 'msa-adv-body');
    for (const { category, keys } of roh) {
      body.append(sectionLabel(category));
      const wrap = el('div', 'msa-adv-group');
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
    for (const extraEl of extraAdvanced) body.append(extraEl);
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

  // THE RESET-ALL ROW (2026-10-24, on the author's own ask: "a large obvious
  // and well placed button in MSA Studio to reset all the maps effects to
  // their default values"). Its own full-width row, ABOVE the filter/search
  // strip, so it reads as acting on the whole department rather than as one
  // more chip among the category filters. Two-click armed like every other
  // destructive control in this room (`buildArmButton`) — this one can touch
  // every registered effect's tuning in a single press.
  const resetAllRow = el('div', 'msa-resetall');
  const resettable = models.filter(({ model }) => hasResettableParams(model));
  const resetAllBtn = buildArmButton({
    icon: 'reset',
    label: 'Reset ALL effects to defaults',
    armedLabel: () => `Click again to reset all ${resettable.length} effects`,
    title: "Put every registered effect's tuning on this scene back to its shipped defaults.",
    armedTitle: 'This resets EVERY effect card below — click again within a few seconds to confirm.',
    className: 'msa-btn',
    onConfirm: () => {
      for (const { model } of resettable) resetModelToDefaults(model);
      renderEffectsDepartment(container, ctx);
    },
  });
  resetAllBtn.disabled = resettable.length === 0;
  resetAllRow.append(resetAllBtn);
  const resetAllNote = el(
    'span',
    'msa-resetall-note',
    resettable.length > 0 ? `Affects all ${resettable.length} registered effects on this scene.` : ''
  );
  resetAllRow.append(resetAllNote);

  const strip = el('div', 'msa-strip');
  // Fixed at exactly two columns (mythica-machina-press#548) — the previous
  // auto-fill(minmax(320px,...)) happily packed in a 3rd column on any wide
  // Studio window, which is what made the header-overlap bug (see
  // buildStudioEffectCard) bite in practice: three columns left too little
  // width per card for the badge/tool cluster. `align-items:start` (in the
  // stylesheet): grid items default to `stretch` — confirmed live in the Studio
  // preview harness, opening Water's 54-control Advanced section stretched its
  // row-1 neighbour (Bloom, one slider) to Water's full ~1700px height.
  const grid = el('div', 'msa-grid');

  function makeChip(label, accVar, filterKey) {
    const b = el('button', 'msa-chip', label);
    b.type = 'button';
    b.style.setProperty('--acc', `var(${accVar})`);
    b.setAttribute('aria-pressed', String(activeFilter === filterKey));
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
  const searchWrap = el('div', 'msa-field');
  searchWrap.innerHTML = iconMarkup('search');
  const searchBox = document.createElement('input');
  searchBox.type = 'search';
  searchBox.placeholder = 'Filter the cards below by name or control…';
  searchBox.value = searchQuery;
  searchBox.setAttribute('aria-label', 'Filter effects in this category');
  searchWrap.append(searchBox);
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
    decorateModel(model, id, ctx);
    // Detaches to a floating mini-panel for side-by-side lookdev (Testament
    // §5.2). Synthesised here, not per-effect data — every card gets one.
    // `originRect` is the pop-out button's own rect: the new window scales out
    // from there rather than from nowhere.
    model.onPopOut = (originRect) => {
      poppedOut.set(
        model.id,
        popOutCard(model, ctx, () => renderEffectsDepartment(container, ctx), originRect)
      );
      renderEffectsDepartment(container, ctx);
    };
    const cardEl = buildStudioEffectCard(model);
    cardEls.push({ model, el: cardEl });
    grid.append(cardEl);
  }
  if (visible.length === 0) {
    grid.append(
      el(
        'div',
        'msa-empty',
        models.length === 0
          ? 'No effects registered yet.'
          : poppedOut.size > 0
            ? 'Every matching card is popped out.'
            : 'No effects in this category.'
      )
    );
  }
  // Search-only empty state — distinct from the category one above, since
  // the category empty state renders INSTEAD of cards (no cardEls to
  // toggle), while this one hides ALREADY-BUILT cards live.
  const noSearchMatch = el('div', 'msa-empty', 'Nothing in this category matches your search.');
  noSearchMatch.hidden = true;
  grid.append(noSearchMatch);

  /** Apply `query` live to the already-built cards — no re-render, so the
   * search box itself never loses focus mid-type. Re-run on every render
   * too (a chip click rebuilds the grid from scratch), so an active search
   * survives switching categories. */
  function applySearchFilter(query) {
    searchQuery = (query ?? '').trim().toLowerCase();
    let anyVisible = false;
    for (const { model, el: cardEl } of cardEls) {
      const match = cardMatchesSearch(model, searchQuery);
      cardEl.hidden = !match;
      if (match) anyVisible = true;
    }
    noSearchMatch.hidden = cardEls.length === 0 || anyVisible;
  }
  searchBox.addEventListener('input', () => applySearchFilter(searchBox.value));
  applySearchFilter(searchQuery);

  container.innerHTML = '';
  container.append(resetAllRow, strip, grid);
  return `${models.length} registered — every card generated from its schema`;
}

/**
 * A card, detached into its own small floating window — a VIEW, never a
 * second live control over the same param (the exact bug FOH/ROH's own
 * partition law exists to prevent, one level up: two independent DOM nodes
 * for one value, silently disagreeing). The grid re-renders without this
 * card the moment it pops out; closing the window re-adds it.
 *
 * The window opens by scaling up from the button that made it (`originRect`),
 * so it reads as that card coming OUT of the grid rather than a window
 * appearing from nowhere; it starts at .96, never at 0.
 * @param {object} model @param {object} ctx @param {() => void} onClosed
 * @param {DOMRect} [originRect] the pop-out button's rect.
 * @returns {HTMLElement} the floating window, so the caller can track/remove it.
 */
function popOutCard(model, ctx, onClosed, originRect) {
  const win = el('div', POPOUT_CLASS);
  const top = 100 + poppedOut.size * 24;
  const left = 140 + poppedOut.size * 24;
  win.style.top = `${top}px`;
  win.style.left = `${left}px`;
  if (originRect) {
    // Clamped to the window's own box: the button may be scrolled far out of
    // view (or off to the side), and scaling from a point a screen away would
    // make the whole window slide in from it instead of just growing.
    const within = (v, max) => Math.round(Math.min(max, Math.max(0, v)));
    win.style.setProperty('--ox', `${within(originRect.left + originRect.width / 2 - left, 360)}px`);
    win.style.setProperty('--oy', `${within(originRect.top + originRect.height / 2 - top, 120)}px`);
  }
  const head = el('div', 'msa-pop-head');
  const title = el('span', 'msa-pop-title', model.title);
  const closeBtn = iconButton('x', 'Close (returns the card to the grid)');
  closeBtn.addEventListener('click', () => {
    poppedOut.delete(model.id);
    win.remove();
    onClosed();
  });
  head.append(title, closeBtn);
  win.append(head);
  // A fresh model (re-fetched, never the closed-over one) each time the
  // pop-out itself needs to redraw — same "never a captured readout" rule
  // as everything else this canon renders.
  const rerenderCard = () => {
    win.querySelector('[data-msa-effect]')?.remove();
    const freshModel = ctx.effectCardFactories.get(model.id)?.() ?? model;
    freshModel.onRequestRerender = rerenderCard;
    decorateModel(freshModel, model.id, ctx);
    freshModel.onPopOut = undefined; // already popped out; no second popout button on a popout
    win.append(buildStudioEffectCard(freshModel));
  };
  rerenderCard();
  document.body.appendChild(win);
  return win;
}

/**
 * Attach the department-level hooks every card needs onto its model — the same
 * "attach what the card needs onto model itself" shape `onRequestRerender`
 * already uses. Shared by the grid AND the pop-out window: the pop-out used to
 * re-fetch a bare model from its factory and so silently lost "my presets" and
 * the health-badge link that the very same card has in the grid.
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
