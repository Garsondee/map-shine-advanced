/**
 * ui/rooms/guide/guide-room.js — the Map Shine Guide, opened from the Remote's
 * big Help button (mmp-0mv, Ingram 2026-11-07).
 *
 * TWO HALVES, one switch at the top:
 *   QUICK FIXES — "something looks wrong right now". Short pages, one problem each,
 *     with buttons that change the scene on the spot, say exactly what they changed
 *     (from → to, and where that control lives) and can be undone. Built to be used
 *     mid-session: a side panel, the map stays visible beside it.
 *   LEARN — how to make your own maps shine: the masks, how to paint them in an image
 *     editor, and how to get the best from every effect, illustrated with real
 *     Mythica Machina maps (named in every caption).
 *
 * The content lives in `guide/` at the module root (Markdown pages + WebP images +
 * `guide.json`, the page list), fetched on first open. Nothing here runs until then.
 *
 * Built like every other room: hand-made DOM, the shared room kit, tokens.js themes.
 *
 * @module ui/rooms/guide/guide-room
 */

import { installTokens } from '../../tokens.js';
import { installIconSprite, iconMarkup } from '../../widgets/icon-sprite.js';
import { installTooltips } from '../../widgets/tooltip.js';
import { replayClass } from '../room-style.js';
import { raiseRoom, raiseRoomOnPress } from '../room-stack.js';
import { GUIDE_ROOM_ID, GUIDE_TOOLTIP_SCOPE, guideCss } from './guide-style.js';
import { renderGuideMarkdown, guideSearchText, escapeHtml } from './guide-markdown.js';
import { GUIDE_ACTIONS, runGuideAction } from './guide-actions.js';
import { maskCheatTableHtml } from './guide-masks.js';
import { settingsTableHtml } from './guide-settings.js';

const STYLE_ID = 'msa-guide-style';
const STORE_PAGE = 'msa-guide-page';
const STORE_WIDE = 'msa-guide-wide';

/** The Remote's closures, set once at Remote install (`configureGuide`), so the guide can be
 * opened from anywhere — the painter's Masks list, a Studio effect card — with working buttons. */
let defaultCtx = {};

/** @param {object} ctx - the same shape `installGuide` takes. */
export function configureGuide(ctx) {
  defaultCtx = ctx ?? {};
}

/**
 * Open the guide on a page from anywhere in the UI (`'fixes'`, `'learn'`, a page id, `id#anchor`).
 * Builds the room on first use with the context the Remote configured.
 * @param {string} [target]
 */
export function openGuide(target) {
  return installGuide(defaultCtx).open(target);
}

/** The module-root `guide/` folder, wherever the module is served from. */
export const GUIDE_BASE_URL = new URL('../../../../guide/', import.meta.url).href;

function readLocal(key, fallback) {
  try {
    return window.localStorage?.getItem(key) ?? fallback;
  } catch (_) {
    return fallback;
  }
}
function writeLocal(key, value) {
  try {
    window.localStorage?.setItem(key, value);
  } catch (_) {
    // storage blocked — not remembered, nothing else changes
  }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

/**
 * @param {object} ctx
 * @param {object} [ctx.remote] - the Remote's own closures (weatherBoard, onSweepToHour,
 *   getFadeOverMs, looks, getRendererOverride, onRendererOverrideChange)
 * @param {(setterName: string) => (Function|null)} [ctx.effectSetter] - an effect's public setter
 *   (`setBloom`, `setGrade`…), handed in by boot.js through the Remote
 * @param {(target: string) => (boolean|void|Promise<boolean|void>)} [ctx.openTool]
 * @param {() => number} [ctx.getHour]
 * @param {() => boolean} [ctx.isGM]
 * @param {(url: string) => Promise<string>} [ctx.fetchText] - injectable for previews
 */
export function installGuide(ctx = {}) {
  installTokens();
  installIconSprite();
  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = guideCss();
    document.head.appendChild(s);
  }
  const existing = document.getElementById(GUIDE_ROOM_ID);
  if (existing?._msaGuideController) return existing._msaGuideController;

  const fetchText =
    ctx.fetchText ??
    (async (url) => {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.text();
    });
  const imageUrl = (file) => new URL(`images/${file}`, GUIDE_BASE_URL).href;

  const state = {
    open: false,
    manifest: null,
    loading: null,
    page: readLocal(STORE_PAGE, 'fixes'),
    wide: readLocal(STORE_WIDE, '') === '' ? null : readLocal(STORE_WIDE, 'false') === 'true',
    history: [],
    query: '',
  };
  /** page id -> markdown text */
  const pageText = new Map();
  /** Every change a button made this session, newest last: {label, undo, row}. */
  const undoStack = [];

  // ---- DOM -------------------------------------------------------------------------
  const room = el('section');
  room.id = GUIDE_ROOM_ID;
  room.hidden = true;
  room.setAttribute('aria-label', 'Map Shine Guide');
  const card = el('div', 'g-card-room');

  const head = el('header', 'g-head');
  const brand = el('div', 'g-brand', `${iconMarkup('book')}<span>Map Shine Guide</span>`);
  const search = el('input', 'g-search');
  search.type = 'search';
  search.placeholder = 'Search…';
  search.setAttribute('aria-label', 'Search the guide');
  const wideBtn = el('button', 'hbtn', iconMarkup('frame'));
  wideBtn.type = 'button';
  wideBtn.title = 'Wide reading view (bigger pictures, page list)';
  const closeBtn = el('button', 'hbtn', iconMarkup('x'));
  closeBtn.type = 'button';
  closeBtn.title = 'Close the guide';
  head.append(brand, el('span', 'g-spacer'), search, wideBtn, closeBtn);

  const halves = el('div', 'g-halves');
  const halfBtns = new Map();

  const crumbs = el('nav', 'g-crumbs');
  crumbs.setAttribute('aria-label', 'Where you are');
  const body = el('div', 'g-body');
  const toc = el('nav', 'g-toc');
  toc.setAttribute('aria-label', 'Pages');
  const scroll = el('div', 'g-scroll');
  const page = el('article', 'g-page');
  scroll.append(page);
  body.append(toc, scroll);
  const foot = el('footer', 'g-foot');

  card.append(head, halves, crumbs, body, foot);
  room.append(card);
  document.body.append(room);
  raiseRoomOnPress(room);
  // One step above a normally raised room (101): the guide is often opened FROM another
  // tool — the painter's toolbar sits at 101 and would otherwise cover its header.
  const lift = () => {
    room.style.zIndex = '102';
  };
  room.addEventListener('pointerdown', lift, true);
  installTooltips({ scope: GUIDE_TOOLTIP_SCOPE });

  // ---- data --------------------------------------------------------------------------
  function loadManifest() {
    if (state.manifest) return Promise.resolve(state.manifest);
    if (!state.loading) {
      state.loading = fetchText(new URL('guide.json', GUIDE_BASE_URL).href)
        .then((t) => {
          state.manifest = JSON.parse(t);
          buildHalves();
          return state.manifest;
        })
        .catch((err) => {
          state.loading = null;
          throw err;
        });
    }
    return state.loading;
  }
  const pageById = (id) => state.manifest?.pages.find((p) => p.id === id) ?? null;
  const halfOf = (id) => pageById(id)?.half ?? 'fixes';
  const pagesOfHalf = (half) => state.manifest.pages.filter((p) => p.half === half);

  async function loadPage(id) {
    if (pageText.has(id)) return pageText.get(id);
    const text = await fetchText(new URL(`pages/${id}.md`, GUIDE_BASE_URL).href);
    pageText.set(id, text);
    return text;
  }

  // ---- chrome ------------------------------------------------------------------------
  function buildHalves() {
    halves.replaceChildren();
    for (const h of state.manifest.halves) {
      const b = el(
        'button',
        'g-half',
        `${iconMarkup(h.icon)}<span><b>${escapeHtml(h.title)}</b><span>${escapeHtml(h.blurb)}</span></span>`
      );
      b.type = 'button';
      b.dataset.half = h.id;
      b.addEventListener('click', () => go(h.home));
      halfBtns.set(h.id, b);
      halves.append(b);
    }
  }

  function paintChrome(p) {
    const half = p?.half ?? 'fixes';
    for (const [id, b] of halfBtns) b.setAttribute('aria-pressed', String(id === half));
    const hub = state.manifest.halves.find((h) => h.id === half);
    room.dataset.half = half;
    room.dataset.wide = String(isWide(half));
    wideBtn.setAttribute('aria-pressed', String(isWide(half)));

    // breadcrumb: back + half + here
    crumbs.replaceChildren();
    const isHome = p && hub && p.id === hub.home;
    if (!isHome && p) {
      const back = el(
        'button',
        'g-nav-btn g-back',
        `${iconMarkup('chev')}<span>${escapeHtml(hub?.title ?? 'Back')}</span>`
      );
      back.type = 'button';
      back.addEventListener('click', () =>
        go(state.history.length ? state.history[state.history.length - 1] : hub.home, { back: true })
      );
      crumbs.append(back);
      if (p.section) crumbs.append(el('span', null, escapeHtml(p.section)), el('span', null, '›'));
      crumbs.append(el('span', 'g-crumb-here', escapeHtml(p.title)));
    } else {
      crumbs.append(el('span', 'g-crumb-here', escapeHtml(hub?.lead ?? '')));
    }

    // page list (wide view)
    toc.replaceChildren();
    let section = null;
    for (const q of pagesOfHalf(half)) {
      if (q.section !== section) {
        section = q.section;
        if (section) toc.append(el('h4', null, escapeHtml(section)));
      }
      const b = el(
        'button',
        'g-toc-link',
        `${iconMarkup(q.icon ?? 'dots')}<span>${escapeHtml(q.navTitle ?? q.title)}</span>`
      );
      b.type = 'button';
      if (p && q.id === p.id) b.setAttribute('aria-current', 'page');
      b.addEventListener('click', () => go(q.id));
      toc.append(b);
    }

    // previous / next within the half
    foot.replaceChildren();
    const list = pagesOfHalf(half);
    const ix = p ? list.findIndex((q) => q.id === p.id) : -1;
    const prev = ix > 0 ? list[ix - 1] : null;
    const next = ix >= 0 && ix < list.length - 1 ? list[ix + 1] : null;
    if (prev) {
      const b = el(
        'button',
        'g-nav-btn g-prev',
        `${iconMarkup('chev')}<span>${escapeHtml(prev.navTitle ?? prev.title)}</span>`
      );
      b.type = 'button';
      b.addEventListener('click', () => go(prev.id));
      foot.append(b);
    }
    if (next) {
      const b = el(
        'button',
        'g-nav-btn g-next',
        `<span>${escapeHtml(next.navTitle ?? next.title)}</span>${iconMarkup('chev')}`
      );
      b.type = 'button';
      b.addEventListener('click', () => go(next.id));
      foot.append(b);
    }
    foot.hidden = !prev && !next;
  }

  /** Quick Fixes default to the compact side panel; Learn to the wide reading view. */
  function isWide(half) {
    if (state.wide !== null) return state.wide;
    return half === 'learn';
  }

  // ---- navigation ----------------------------------------------------------------------
  let renderSeq = 0;
  async function go(id, { back = false, anchor = null } = {}) {
    await loadManifest();
    const target = pageById(id) ? id : state.manifest.halves[0].home;
    if (back) state.history.pop();
    else if (state.page && state.page !== target && !state.query) state.history.push(state.page);
    if (state.history.length > 30) state.history.shift();
    state.page = target;
    state.query = '';
    search.value = '';
    writeLocal(STORE_PAGE, target);
    const seq = ++renderSeq;
    const p = pageById(target);
    paintChrome(p);
    let md;
    try {
      md = await loadPage(target);
    } catch (err) {
      if (seq !== renderSeq) return;
      page.innerHTML = `<h2>${escapeHtml(p.title)}</h2><p class="g-bad">This page could not be loaded (${escapeHtml(
        err?.message ?? err
      )}).</p>`;
      return;
    }
    if (seq !== renderSeq) return;
    const r = renderGuideMarkdown(md, { imageUrl });
    page.innerHTML = `<h2>${escapeHtml(p.title)}</h2>${r.html}`;
    page.querySelector(':scope > p')?.classList.add('g-lead');
    hydrate(page);
    if (anchor) page.querySelector(`#g-${CSS.escape(anchor)}`)?.scrollIntoView();
    else scroll.scrollTop = 0;
  }

  // ---- making a rendered page live -------------------------------------------------------------
  function hydrate(root) {
    for (const a of root.querySelectorAll('a.g-link[data-page], a.g-link[data-anchor]:not([data-page])')) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (a.dataset.page) go(a.dataset.page, { anchor: a.dataset.anchor ?? null });
        else root.querySelector(`#g-${CSS.escape(a.dataset.anchor)}`)?.scrollIntoView({ behavior: 'smooth' });
      });
    }
    for (const box of root.querySelectorAll('.g-cards')) fillCards(box);
    for (const box of root.querySelectorAll('.g-actions')) fillActions(box);
    for (const box of root.querySelectorAll('.g-live')) fillLive(box);
    for (const fig of root.querySelectorAll('.g-compare')) {
      const range = fig.querySelector('.g-compare-range');
      range?.addEventListener('input', () => fig.style.setProperty('--split', `${range.value}%`));
    }
  }

  function fillCards(box) {
    for (const id of box.dataset.cards.split(',')) {
      const p = pageById(id);
      if (!p) continue;
      const b = el('button', 'g-card');
      b.type = 'button';
      b.dataset.tone = p.half;
      const thumb = p.thumb
        ? `<img class="g-card-thumb" src="${escapeHtml(imageUrl(p.thumb))}" alt="" loading="lazy">`
        : '';
      b.innerHTML = `${thumb}<span class="g-card-text"><span class="g-card-ico">${iconMarkup(p.icon ?? 'dots')}</span><span><b>${escapeHtml(
        p.title
      )}</b><small>${escapeHtml(p.summary ?? '')}</small></span></span>`;
      b.addEventListener('click', () => go(id));
      box.append(b);
    }
  }

  function actionEnv() {
    return {
      effectSetter: ctx.effectSetter,
      readSceneEffectParams: (effectId) => {
        try {
          const all = globalThis.canvas?.scene?.getFlag?.('map-shine-advanced', 'effectParams');
          const params = all && typeof all === 'object' ? all[effectId] : null;
          return { params: params && typeof params === 'object' ? params : null };
        } catch (_) {
          return { params: null };
        }
      },
      readSetting: (key) => {
        try {
          return globalThis.game?.settings?.get('map-shine-advanced', key);
        } catch (_) {
          return undefined;
        }
      },
      writeSetting: (key, v) => globalThis.game?.settings?.set('map-shine-advanced', key, v),
      remote: ctx.remote ?? {},
      getHour: ctx.getHour,
      open: ctx.openTool,
    };
  }

  function fillActions(box) {
    const results = el('div', 'g-results');
    results.setAttribute('aria-live', 'polite');
    for (const id of box.dataset.actions.split(',')) {
      const a = GUIDE_ACTIONS[id];
      if (!a) continue;
      const b = el('button', 'g-act', `${iconMarkup(a.icon ?? 'check')}<span>${escapeHtml(a.label)}</span>`);
      b.type = 'button';
      b.addEventListener('click', async () => {
        if (b.dataset.busy === 'true') return;
        b.dataset.busy = 'true';
        try {
          const r = await runGuideAction(id, actionEnv());
          showResult(results, a, r);
        } finally {
          b.dataset.busy = 'false';
        }
      });
      box.append(b);
    }
    box.after(results);
  }

  function showResult(results, action, r) {
    const row = el('div', 'g-result');
    row.dataset.ok = String(r.ok);
    const parts = [];
    if (r.changes?.length) {
      parts.push(
        r.changes
          .map(
            (c) =>
              `<span class="g-chg">${escapeHtml(c.label)} <i>${escapeHtml(c.from)} →</i> ${escapeHtml(c.to)}</span>`
          )
          .join(' ')
      );
    }
    if (r.message && (!r.changes?.length || !r.ok || r.message !== 'Done.'))
      parts.push(`<span>${escapeHtml(r.message)}</span>`);
    if (r.where) parts.push(`<span class="g-where">Find it later: ${escapeHtml(r.where)}</span>`);
    row.innerHTML = parts.join('');
    if (typeof r.undo === 'function') {
      const u = el('button', 'g-undo', 'Undo');
      u.type = 'button';
      const entry = { label: action.label, undo: r.undo, row };
      undoStack.push(entry);
      u.addEventListener('click', async () => {
        u.disabled = true;
        const res = await entry.undo().catch((err) => ({ ok: false, message: String(err?.message ?? err) }));
        row.dataset.undone = 'true';
        u.textContent = res.ok ? 'Undone' : 'Undo failed';
        const i = undoStack.indexOf(entry);
        if (i >= 0) undoStack.splice(i, 1);
      });
      row.append(u);
    }
    results.prepend(row);
    while (results.children.length > 4) results.lastElementChild.remove();
  }

  function fillLive(box) {
    if (box.dataset.live === 'settings') {
      box.innerHTML = settingsTableHtml(box.dataset.effect);
      return;
    }
    if (box.dataset.live === 'masks-table') {
      box.innerHTML = maskCheatTableHtml();
      hydrate(box);
      return;
    }
    if (box.dataset.live === 'looks') {
      const looks = ctx.remote?.looks;
      const list = (() => {
        try {
          return looks?.list?.() ?? [];
        } catch (_) {
          return [];
        }
      })();
      if (!list.length) {
        box.innerHTML = '<p>No Looks saved in this world yet. Save one from the Remote: Play → Save look.</p>';
        return;
      }
      const wrap = el('div', 'g-looks');
      const results = el('div', 'g-results');
      for (const look of list.slice(0, 24)) {
        const b = el('button', 'g-look', escapeHtml(look.name ?? look.id));
        b.type = 'button';
        b.addEventListener('click', async () => {
          const overMs = ctx.remote?.getFadeOverMs?.() ?? 0;
          try {
            await looks.play(look.id, overMs);
            showResult(
              results,
              { label: look.name },
              {
                ok: true,
                message: `Playing “${look.name}”${overMs ? ` over ${Math.round(overMs / 1000)} s` : ''}.`,
                changes: [],
                where: 'Remote → Play → Looks',
                undo: null,
              }
            );
          } catch (err) {
            showResult(
              results,
              { label: look.name },
              { ok: false, message: String(err?.message ?? err), changes: [], undo: null }
            );
          }
        });
        wrap.append(b);
      }
      box.append(wrap, results);
    }
  }

  // ---- search ---------------------------------------------------------------------------------------
  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(search.value.trim()), 160);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      search.value = '';
      go(state.page);
      e.stopPropagation();
    }
  });

  async function runSearch(q) {
    await loadManifest();
    if (!q) {
      if (state.query) {
        state.query = '';
        go(state.page);
      }
      return;
    }
    state.query = q;
    const seq = ++renderSeq;
    await Promise.all(state.manifest.pages.map((p) => loadPage(p.id).catch(() => '')));
    if (seq !== renderSeq) return;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [];
    for (const p of state.manifest.pages) {
      const text = guideSearchText(pageText.get(p.id) ?? '');
      const hay = `${p.title} ${p.summary ?? ''} ${text}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      const at = text.toLowerCase().indexOf(words[0]);
      const snippet = at >= 0 ? text.slice(Math.max(0, at - 50), at + 110) : (p.summary ?? '');
      const score = words.reduce(
        (s, w) => s + (p.title.toLowerCase().includes(w) ? 10 : 0) + (hay.split(w).length - 1),
        0
      );
      hits.push({ p, snippet, score });
    }
    hits.sort((a, b) => b.score - a.score);
    const mark = (s) => {
      let out = escapeHtml(s);
      for (const w of words) out = out.replace(new RegExp(`(${escapeRegExp(escapeHtml(w))})`, 'gi'), '<mark>$1</mark>');
      return out;
    };
    page.innerHTML = `<h2>Search</h2><p>${hits.length} page${hits.length === 1 ? '' : 's'} for “${escapeHtml(q)}”.</p>`;
    const list = el('div', 'g-hits');
    for (const h of hits.slice(0, 30)) {
      const half = state.manifest.halves.find((x) => x.id === h.p.half);
      const b = el(
        'button',
        'g-hit',
        `<b>${mark(h.p.title)}</b> <small>${escapeHtml(half?.title ?? '')} · …${mark(h.snippet)}…</small>`
      );
      b.type = 'button';
      b.addEventListener('click', () => go(h.p.id));
      list.append(b);
    }
    page.append(list);
    scroll.scrollTop = 0;
  }

  // ---- header buttons + keys ----------------------------------------------------------------------
  wideBtn.addEventListener('click', () => {
    const half = halfOf(state.page);
    state.wide = !isWide(half);
    writeLocal(STORE_WIDE, String(state.wide));
    room.dataset.wide = String(state.wide);
    wideBtn.setAttribute('aria-pressed', String(state.wide));
  });
  closeBtn.addEventListener('click', () => controller.close());
  room.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target !== search) controller.close();
  });
  card.addEventListener('animationend', (e) => {
    if (e.target === card) card.classList.remove('msa-enter');
  });

  const openListeners = new Set();
  const controller = {
    /** Open the guide, optionally on a page (`'fixes'`, `'learn'`, a page id, `id#anchor`). */
    async open(target) {
      const wasOpen = state.open;
      state.open = true;
      room.hidden = false;
      raiseRoom(room);
      lift();
      if (!wasOpen) replayClass(card, 'msa-enter');
      for (const fn of openListeners) fn(true);
      try {
        await loadManifest();
      } catch (err) {
        page.innerHTML = `<h2>Map Shine Guide</h2><p class="g-bad">The guide could not be loaded (${escapeHtml(
          err?.message ?? err
        )}). Is the module's <code>guide/</code> folder installed?</p>`;
        return;
      }
      const [id, anchor] = String(target ?? state.page ?? 'fixes').split('#');
      await go(id, { anchor: anchor ?? null });
    },
    close() {
      state.open = false;
      room.hidden = true;
      for (const fn of openListeners) fn(false);
    },
    /** Called with true/false whenever the guide opens or closes. */
    onOpenChange(fn) {
      openListeners.add(fn);
    },
    toggle(target) {
      if (state.open && !target) controller.close();
      else controller.open(target);
    },
    isOpen: () => state.open,
    /** How many button changes can still be undone this session. */
    pendingUndos: () => undoStack.length,
  };
  room._msaGuideController = controller;
  return controller;
}
