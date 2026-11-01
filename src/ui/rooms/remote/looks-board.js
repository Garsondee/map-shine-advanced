/**
 * ui/rooms/remote/looks-board.js — THE LOOKS GRID, the heart of the Remote's Play
 * tab (2026-11-01 redesign). One tile per Look; pressing a tile fades the whole
 * scene to it over the Fade Time. The last tile saves the scene as it is now as a
 * new Look, with the facets the GM chooses (core/looks-schema.js explains facets).
 *
 * Each tile is drawn as its own little sky (`lookSwatch`) with the facets it holds
 * as small glyphs, so a row of Looks reads at a glance and a time-agnostic Look
 * visibly says so (no clock glyph, a neutral slate sky).
 *
 * Everything that changes data goes through `ctx` (boot.js's Looks engine); this
 * file keeps no Look state of its own beyond which form or menu is open.
 *
 * @module ui/rooms/remote/looks-board
 */

import {
  LOOK_FACETS,
  LOOK_PALETTE,
  describeLook,
  lookOptions,
  LOOK_GROUPS,
  lookGroup,
  lookSwatch,
  optionPaletteId,
  reconcileLook,
} from '../../../core/looks-schema.js';
import { WEATHER_ARCHETYPES } from '../../../world/index.js';
import { iconMarkup } from '../../widgets/icon-sprite.js';
import { setTip } from '../../widgets/tooltip.js';
import { buildArmButton } from '../../widgets/inline-actions.js';

/** Human label for a weather archetype id. */
export function archetypeLabel(id) {
  return WEATHER_ARCHETYPES.find((a) => a.id === id)?.label;
}
/** An archetype's own cloud cover, for a tile's swatch. */
export function archetypeCloud(id) {
  return WEATHER_ARCHETYPES.find((a) => a.id === id)?.axes?.cloudCover01;
}

/**
 * @typedef {object} LooksCtx
 * @property {() => import('../../../core/looks-schema.js').Look[]} list
 * @property {(id: string, overMs: number) => {ok: boolean, reason: string|null, skipped?: Array<{key: string, reason: string}>}} play
 * @property {(name: string, facets: string[]) => Promise<{ok: boolean, reason: string|null}>} capture
 * @property {(id: string) => Promise<unknown>} recapture
 * @property {(id: string, facets: string[]) => Promise<{ok?: boolean, reason?: string|null}>} setFacets
 * @property {(id: string, name: string) => Promise<unknown>} rename
 * @property {(id: string) => Promise<unknown>} remove
 * @property {() => string[]} sequence
 * @property {(ids: string[]) => Promise<unknown>} setSequence
 * @property {() => string|null} activeId - the Look last played here
 * @property {() => boolean} isFading - whether that Look is still fading in
 * @property {() => boolean} isWorldClock
 */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A row of facet toggle chips. @returns {{root: HTMLElement, get: () => string[]}} */
export function buildFacetPicker(initial) {
  const chosen = new Set(initial);
  const root = el('div', 'msa-facets');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'What this Look sets');
  for (const facet of LOOK_FACETS) {
    const b = el('button', 'msa-facet');
    b.type = 'button';
    b.innerHTML = `${iconMarkup(facet.icon)}<span>${facet.label}</span>`;
    b.title = facet.help;
    b.setAttribute('aria-pressed', String(chosen.has(facet.id)));
    b.addEventListener('click', () => {
      if (chosen.has(facet.id)) chosen.delete(facet.id);
      else chosen.add(facet.id);
      b.setAttribute('aria-pressed', String(chosen.has(facet.id)));
    });
    root.appendChild(b);
  }
  return { root, get: () => LOOK_FACETS.map((f) => f.id).filter((id) => chosen.has(id)) };
}

/**
 * @param {HTMLElement} container
 * @param {LooksCtx} ctx
 * @param {{getFadeOverMs: () => number, getFadeLabel: () => string, onStatus: (text: string) => void}} env
 */
export function renderLooksBoard(container, ctx, env) {
  const wrap = el('div', 'msa-looks');
  const head = el('div', 'msa-section-head');
  const title = el('span', 'msa-section-title');
  title.innerHTML = `${iconMarkup('layers')}<span>Looks</span>`;
  const fadeSlot = el('div', 'msa-fade-slot');
  // "Scene start" — the old footer's Baseline: the weather as this scene loaded. A small
  // button by the title rather than a tile, so the grid is exactly the Looks + Save.
  if (ctx.baseline) {
    const reset = el('button', 'hbtn msa-looks-reset');
    reset.type = 'button';
    reset.innerHTML = iconMarkup('reset');
    reset.title = 'Scene start — fade the weather back to how this scene was when it loaded.';
    reset.addEventListener('click', () => {
      closeMenu();
      ctx.baseline(env.getFadeOverMs());
      env.onStatus('Fading back to how this scene loaded.');
    });
    head.append(title, reset, fadeSlot);
  } else head.append(title, fadeSlot);

  // THE GROUP CHIPS (round 3): one themed group at a time, so thirty-odd Looks stay
  // findable at a glance. The choice is remembered per browser.
  const GROUP_KEY = 'msa-remote-look-group';
  let group = 'day';
  try {
    group = window.localStorage?.getItem(GROUP_KEY) || 'day';
  } catch (_) {
    group = 'day';
  }
  if (!LOOK_GROUPS.some((g) => g.id === group)) group = 'day';
  const groupRow = el('div', 'msa-groups');
  groupRow.setAttribute('role', 'tablist');
  groupRow.setAttribute('aria-label', 'Look groups');
  function setGroup(id) {
    group = id;
    try {
      window.localStorage?.setItem(GROUP_KEY, id);
    } catch (_) {
      // storage blocked — the group simply resets next load
    }
    closeMenu();
    paint();
  }
  function paintGroups() {
    const counts = new Map();
    for (const l of ctx.list()) counts.set(lookGroup(l), (counts.get(lookGroup(l)) ?? 0) + 1);
    groupRow.replaceChildren(
      ...LOOK_GROUPS.map((g) => {
        const b = el('button', 'msa-group');
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(g.id === group));
        b.title = `${g.label} — ${g.help}`;
        b.innerHTML = `${iconMarkup(g.icon)}<span>${g.label}</span>`;
        if (counts.get(g.id)) b.dataset.count = String(counts.get(g.id));
        b.addEventListener('click', () => setGroup(g.id));
        return b;
      })
    );
  }
  const grid = el('div', 'msa-look-grid');
  grid.setAttribute('role', 'list');
  const formHost = el('div', 'msa-look-form-host');
  const menuHost = el('div', 'msa-look-menu-host');
  wrap.append(head, groupRow, grid, formHost, menuHost);
  container.appendChild(wrap);

  /** Which tile's menu is open (by id), or null. */
  let menuFor = null;
  let formOpen = false;

  function closeMenu() {
    menuFor = null;
    menuHost.replaceChildren();
    for (const t of grid.querySelectorAll('.msa-look')) t.removeAttribute('data-menu');
  }

  function play(id, overMs) {
    const result = ctx.play(id, overMs);
    if (!result?.ok) env.onStatus(result?.reason ? `Could not play: ${result.reason}` : 'Could not play that Look.');
    else if (result.skipped?.length) {
      const timeSkipped = result.skipped.some((s) => s.key === 'time.hour');
      env.onStatus(
        timeSkipped
          ? 'Played everything but the hour — the World clock owns time (switch in Prep).'
          : `Played, but ${result.skipped.length} saved setting(s) no longer exist (Prep → Looks → Tidy).`
      );
    } else env.onStatus('');
    paint();
  }

  function tile(look) {
    const { facets, stale, invalid } = reconcileLook(look, { isKnownArchetype: (id) => Boolean(archetypeLabel(id)) });
    const sw = lookSwatch(look, { cloudOf: archetypeCloud });
    const t = el('button', 'msa-look');
    t.type = 'button';
    t.setAttribute('role', 'listitem');
    t.style.setProperty('--look-top', sw.top);
    t.style.setProperty('--look-bottom', sw.bottom);
    const swatch = el('span', 'msa-look-sky');
    const glyphs = el('span', 'msa-look-facets');
    glyphs.innerHTML = LOOK_FACETS.filter((f) => facets.includes(f.id))
      .map((f) => iconMarkup(f.icon))
      .join('');
    swatch.appendChild(glyphs);
    if (stale.length + invalid.length > 0) {
      const warn = el('span', 'msa-look-warn');
      warn.innerHTML = iconMarkup('warn');
      swatch.appendChild(warn);
    }
    // One colour: a band of the kept colour across the grey sky.
    if (sw.band) {
      const band = el('span', 'msa-look-band');
      band.style.background = sw.band;
      swatch.appendChild(band);
    }
    const name = el('span', 'msa-look-name', look.name);
    t.append(swatch, name);
    // THE OPTION BUTTON (author 2026-11-01: "some Looks should have a button on them
    // which allows the GM to select an alternative colour"): a dot of the current
    // colour; it opens the palette. A span, like the corner menu button, because a
    // tile is itself a button.
    const options = lookOptions(look);
    if (options.length > 0) {
      const dot = el('span', 'msa-look-opt');
      dot.style.background = optionColour(look, options[0].key);
      dot.title = `${options[0].label}: pick another colour`;
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        openOptions(look);
      });
      t.appendChild(dot);
    }
    const isActive = ctx.activeId() === look.id;
    t.setAttribute('aria-pressed', String(isActive));
    if (isActive && ctx.isFading()) t.dataset.fading = 'true';
    const timeNote = ctx.isWorldClock() && facets.includes('time') ? ' (hour skipped: World clock)' : '';
    t.title = `${look.name} — ${describeLook(look, archetypeLabel)}${timeNote}\nClick: fade to it over the Fade Time. Right-click: more.`;
    t.addEventListener('click', () => {
      closeMenu();
      play(look.id, env.getFadeOverMs());
    });
    t.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(look);
    });
    // The menu also opens from a small corner button, for anyone who never right-clicks.
    const more = el('span', 'msa-look-more');
    more.innerHTML = iconMarkup('chev');
    more.setAttribute('aria-hidden', 'true');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menuFor === look.id) closeMenu();
      else openMenu(look);
    });
    t.appendChild(more);
    t.dataset.lookId = look.id;
    return t;
  }

  /** The colour an option shows right now (a hue channel draws its hue). */
  function optionColour(look, key) {
    const value = look.values?.[key];
    if (typeof value === 'string') return value;
    return `hsl(${Math.round(Number(value) || 0)}, 80%, 48%)`;
  }

  /** The palette sheet for a Look's options — one row of swatches per option. */
  function openOptions(look) {
    closeMenu();
    menuFor = look.id;
    grid.querySelector(`[data-look-id="${CSS.escape(look.id)}"]`)?.setAttribute('data-menu', 'true');
    const sheet = el('div', 'msa-look-menu');
    const head = el('div', 'msa-look-menu-head', look.name);
    const close = el('button', 'hbtn');
    close.type = 'button';
    close.innerHTML = iconMarkup('x');
    close.title = 'Close';
    close.addEventListener('click', closeMenu);
    head.appendChild(close);
    sheet.appendChild(head);
    for (const option of lookOptions(look)) {
      sheet.appendChild(el('div', 'msa-look-menu-sub', option.label));
      const row = el('div', 'msa-swatches');
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', option.label);
      const current = optionPaletteId(look, option.key);
      for (const swatch of LOOK_PALETTE) {
        const b = el('button', 'msa-swatch');
        b.type = 'button';
        b.style.setProperty('--swatch', swatch.hex);
        b.title = swatch.label;
        b.setAttribute('aria-label', swatch.label);
        b.setAttribute('aria-pressed', String(swatch.id === current));
        b.addEventListener('click', async () => {
          const result = await ctx.setOption(look.id, option.key, swatch.id, env.getFadeOverMs());
          if (result && result.ok === false) env.onStatus(result.reason ?? 'Not changed.');
          else env.onStatus(`${look.name}: ${swatch.label}.`);
          const fresh = ctx.list().find((l) => l.id === look.id);
          if (fresh) openOptions(fresh);
        });
        row.appendChild(b);
      }
      sheet.appendChild(row);
    }
    sheet.appendChild(
      el('div', 'msa-hint', 'Saved for every map. If this Look is playing, it fades to the new colour.')
    );
    menuHost.appendChild(sheet);
  }

  function addTile() {
    const t = el('button', 'msa-look-add');
    t.type = 'button';
    t.innerHTML = `${iconMarkup('save')}<span>Save look</span>`;
    t.title = 'Save the scene as it looks right now as a new Look you can play on any map.';
    t.setAttribute('aria-expanded', String(formOpen));
    t.addEventListener('click', () => {
      formOpen = !formOpen;
      closeMenu();
      paintForm();
      t.setAttribute('aria-expanded', String(formOpen));
    });
    return t;
  }

  function paintForm() {
    formHost.replaceChildren();
    if (!formOpen) return;
    const form = el('form', 'msa-look-form');
    const nameInput = el('input', 'msa-input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Name this look — e.g. "Drowned docks at dusk"';
    nameInput.maxLength = 48;
    nameInput.id = 'msa-look-name-input';
    const hint = el('div', 'msa-hint', 'What should it set? Leave Time off to keep any hour.');
    const picker = buildFacetPicker(LOOK_FACETS.map((f) => f.id));
    const row = el('div', 'msa-look-form-row');
    const save = el('button', 'msa-btn msa-btn--gold', 'Save');
    save.type = 'submit';
    const cancel = el('button', 'msa-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      formOpen = false;
      paint();
    });
    row.append(cancel, save);
    form.append(nameInput, hint, picker.root, row);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      const facets = picker.get();
      if (!name) {
        nameInput.setAttribute('aria-invalid', 'true');
        nameInput.focus();
        return;
      }
      if (facets.length === 0) {
        env.onStatus('Pick at least one thing for the Look to set.');
        return;
      }
      save.disabled = true;
      const result = await ctx.capture(name, facets);
      save.disabled = false;
      if (!result?.ok) {
        env.onStatus(`Not saved: ${result?.reason ?? 'unknown reason'}`);
        return;
      }
      env.onStatus(`Saved "${name}" — it is under Mine, on every map.`);
      group = 'mine';
      formOpen = false;
      paint();
    });
    formHost.appendChild(form);
    nameInput.focus();
  }

  function menuItem(icon, text, onClick, title) {
    const b = el('button', 'msa-menu-item');
    b.type = 'button';
    b.innerHTML = `${iconMarkup(icon)}<span>${text}</span>`;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function openMenu(look) {
    closeMenu();
    menuFor = look.id;
    grid.querySelector(`[data-look-id="${CSS.escape(look.id)}"]`)?.setAttribute('data-menu', 'true');
    const menu = el('div', 'msa-look-menu');
    const head = el('div', 'msa-look-menu-head', look.name);
    const describe = el('div', 'msa-hint', describeLook(look, archetypeLabel));
    const inOrder = ctx.sequence().includes(look.id);
    const items = el('div', 'msa-look-menu-items');
    items.append(
      menuItem('play', 'Play now, no fade', () => {
        closeMenu();
        play(look.id, 0);
      }),
      menuItem(
        'clap',
        inOrder ? 'Add again to running order' : 'Add to running order',
        () => {
          void ctx.setSequence([...ctx.sequence(), look.id]);
          env.onStatus(`"${look.name}" added to this scene's running order.`);
          closeMenu();
        },
        "This scene's GO button plays its running order, one Look per press."
      ),
      menuItem(
        'camera',
        'Update from scene',
        async () => {
          await ctx.recapture(look.id);
          env.onStatus(`"${look.name}" now matches the scene.`);
          closeMenu();
        },
        'Replace this Look with the scene as it looks right now (it keeps what it sets).'
      )
    );

    // Facets — what this Look sets.
    const facetLabel = el('div', 'msa-look-menu-sub', 'Sets');
    const picker = buildFacetPicker(reconcileLook(look).facets);
    const applyFacets = el('button', 'msa-btn msa-btn--sm', 'Apply');
    applyFacets.type = 'button';
    applyFacets.title = 'Removing a facet forgets it; adding one captures it from the scene as it is now.';
    applyFacets.addEventListener('click', async () => {
      const result = await ctx.setFacets(look.id, picker.get());
      if (result && result.ok === false) env.onStatus(result.reason ?? 'Not changed.');
      closeMenu();
    });

    // Rename, inline.
    const renameRow = el('form', 'msa-look-form-row');
    const renameInput = el('input', 'msa-input');
    renameInput.type = 'text';
    renameInput.value = look.name;
    renameInput.maxLength = 48;
    renameInput.id = 'msa-look-rename-input';
    renameInput.setAttribute('aria-label', 'Rename');
    const renameBtn = el('button', 'msa-btn msa-btn--sm', 'Rename');
    renameBtn.type = 'submit';
    renameRow.append(renameInput, renameBtn);
    renameRow.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (renameInput.value.trim()) await ctx.rename(look.id, renameInput.value);
      closeMenu();
    });

    const del = buildArmButton({
      label: 'Delete',
      armedLabel: 'Click again to delete',
      title: 'Delete this Look from every map. Running orders skip it.',
      armedTitle: 'Deletes it for every map at this table. Click again within a few seconds.',
      className: 'msa-btn msa-btn--sm msa-btn--danger',
      onConfirm: async () => {
        await ctx.remove(look.id);
        closeMenu();
      },
    });
    const close = el('button', 'hbtn');
    close.type = 'button';
    close.innerHTML = iconMarkup('x');
    close.title = 'Close';
    close.addEventListener('click', closeMenu);
    head.appendChild(close);

    const footRow = el('div', 'msa-look-form-row');
    footRow.append(del);
    menu.append(head, describe, items, facetLabel, picker.root, applyFacets, renameRow, footRow);
    menuHost.appendChild(menu);
  }

  function paint() {
    paintGroups();
    grid.replaceChildren(
      ...ctx
        .list()
        .filter((l) => lookGroup(l) === group)
        .map(tile),
      addTile()
    );
    paintForm();
    if (menuFor && !ctx.list().some((l) => l.id === menuFor)) closeMenu();
    else if (menuFor) grid.querySelector(`[data-look-id="${CSS.escape(menuFor)}"]`)?.setAttribute('data-menu', 'true');
  }

  paint();
  return {
    /** The slot the shell moves the shared Fade Time control into. */
    fadeSlot,
    refresh: paint,
    /** Light the fading tile without rebuilding the grid (called every tick). */
    syncFading() {
      const active = ctx.activeId();
      const fading = ctx.isFading();
      for (const t of grid.querySelectorAll('.msa-look')) {
        const on = t.dataset.lookId === active;
        if (t.getAttribute('aria-pressed') !== String(on)) t.setAttribute('aria-pressed', String(on));
        const f = on && fading ? 'true' : null;
        if ((t.dataset.fading ?? null) !== f) {
          if (f) t.dataset.fading = f;
          else delete t.dataset.fading;
        }
      }
    },
  };
}

/**
 * THE RUNNING ORDER STRIP — the bottom of Play: the next Look in this scene's
 * running order and a big GO. The list folds open under it for reordering.
 * @param {HTMLElement} container
 * @param {LooksCtx & {nextIndex: () => number, setNextIndex: (i: number) => void,
 *   next: (overMs: number) => {ok: boolean, reason: string|null}}} ctx
 * @param {{getFadeOverMs: () => number, getFadeLabel: () => string, onStatus: (text: string) => void}} env
 */
export function renderRunningOrder(container, ctx, env) {
  const wrap = el('div', 'msa-run');
  const row = el('div', 'msa-cue-row');
  const card = el('button', 'msa-run-card');
  card.type = 'button';
  card.title = "This scene's running order — click to show or edit it.";
  card.setAttribute('aria-expanded', 'false');
  const line = el('div', 'msa-cue-line');
  const k = el('span', 'msa-cue-k', 'Next');
  const name = el('span', 'msa-cue-name');
  line.append(k, name);
  const meta = el('span', 'msa-cue-meta');
  card.append(line, meta);
  const go = el('button', 'msa-cue-go');
  go.type = 'button';
  go.innerHTML = `<span>GO</span>${iconMarkup('play')}`;
  row.append(card, go);
  const list = el('div', 'msa-cue-list');
  list.setAttribute('role', 'list');
  wrap.append(row, list);
  container.appendChild(wrap);

  let open = false;

  function resolved() {
    const byId = new Map(ctx.list().map((l) => [l.id, l]));
    return ctx
      .sequence()
      .map((id, index) => ({ id, index, look: byId.get(id) }))
      .filter((e) => e.look);
  }

  function rowBtn(icon, title, onClick) {
    const b = el('button', 'msa-run-btn');
    b.type = 'button';
    b.innerHTML = iconMarkup(icon);
    b.title = title;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function move(index, dir) {
    const seq = ctx.sequence().slice();
    const j = index + dir;
    if (j < 0 || j >= seq.length) return;
    [seq[index], seq[j]] = [seq[j], seq[index]];
    void ctx.setSequence(seq);
  }

  function paint() {
    const entries = resolved();
    const nextIx = ctx.nextIndex();
    const next = entries[nextIx]?.look ?? null;
    name.textContent = next ? next.name : entries.length === 0 ? 'No running order yet' : 'End of the running order';
    name.dataset.tip = name.textContent;
    name.dataset.tipTruncated = '';
    meta.innerHTML =
      entries.length === 0
        ? 'Right-click a Look → Add to running order'
        : next
          ? `${iconMarkup('clock')}${nextIx + 1} of ${entries.length} · fades over ${env.getFadeLabel()}`
          : `${iconMarkup('reset')}Open the list to start again`;
    go.disabled = !next;
    setTip(go, next ? `Fade to "${next.name}" over ${env.getFadeLabel()}` : 'Nothing next in the running order');

    list.replaceChildren();
    list.classList.toggle('open', open);
    entries.forEach((entry, i) => {
      const r = el('div', `msa-run-row${i < nextIx ? ' done' : i === nextIx ? ' next' : ''}`);
      r.setAttribute('role', 'listitem');
      const label = el('button', 'msa-run-play');
      label.type = 'button';
      label.textContent = entry.look.name;
      label.title = `Play "${entry.look.name}" now and carry on from here`;
      label.addEventListener('click', () => {
        ctx.setNextIndex(i);
        fire();
      });
      r.append(
        label,
        rowBtn('chev', 'Earlier', () => move(entry.index, -1)),
        rowBtn('chev', 'Later', () => move(entry.index, 1)),
        rowBtn('x', 'Remove from the running order', () => {
          const seq = ctx.sequence().slice();
          seq.splice(entry.index, 1);
          void ctx.setSequence(seq);
        })
      );
      r.children[1].classList.add('msa-run-up');
      r.children[2].classList.add('msa-run-down');
      list.appendChild(r);
    });
    if (entries.length > 0) {
      const restart = el('button', 'msa-cue-listrow');
      restart.type = 'button';
      restart.innerHTML = `${iconMarkup('reset')}<span>Back to the start</span>`;
      restart.addEventListener('click', () => {
        ctx.setNextIndex(0);
        paint();
      });
      list.appendChild(restart);
    }
  }

  function fire() {
    const result = ctx.next(env.getFadeOverMs());
    if (!result?.ok) env.onStatus(result?.reason ? `GO: ${result.reason}` : 'GO did nothing.');
    else env.onStatus('');
    paint();
  }

  go.addEventListener('click', fire);
  card.addEventListener('click', () => {
    open = !open;
    card.setAttribute('aria-expanded', String(open));
    paint();
  });

  paint();
  return { refresh: paint };
}
