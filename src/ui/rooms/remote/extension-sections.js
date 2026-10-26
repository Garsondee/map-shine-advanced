/**
 * ui/rooms/remote/extension-sections.js — SECTIONS OTHER MODULES ADD TO THE REMOTE
 *
 * The Remote's own sections are built by shell.js from options boot.js hands it. A section that
 * belongs to ANOTHER MODULE (Footfall's pathing marks is the first) cannot arrive that way — boot.js
 * has never heard of it — so it registers here instead, through MSA's public API
 * (`game.modules.get('map-shine-advanced').api.remote`, assembled in foundry/public-api.js).
 *
 * A section is `{ id, title, icon?, order?, gmOnly?, render(host, ctx) → {refresh?, destroy?} | void }`.
 *   - `render` fills `host`, an element already inside the Remote's body under the section's own title.
 *   - `ctx.kit` builds controls with the Remote's own classes, so a registered section looks and presses
 *     like MSA's (every pressable the Remote knows is a single class — see remote-style.js).
 *   - `refresh` is called when the Remote re-opens; `destroy` when the section is removed or rebuilt.
 *
 * Registration may happen before or after the Remote's body exists: the Remote re-renders on change.
 * Pure registry — no Foundry, no document at import time — so it is unit-testable under Node.
 *
 * @module ui/rooms/remote/extension-sections
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const DEFAULT_ORDER = 100;

/** @type {Map<string, {id: string, title: string, icon: string|null, order: number, gmOnly: boolean, render: Function}>} */
const sections = new Map();
/** @type {Set<() => void>} */
const listeners = new Set();

function announce() {
  for (const fn of [...listeners]) fn();
}

/**
 * Add (or replace) a section.
 * @param {{id: string, title: string, icon?: string, order?: number, gmOnly?: boolean, render: Function}} def
 * @returns {() => void} removes it again
 */
export function registerRemoteSection(def) {
  if (!def || typeof def !== 'object') throw new TypeError('registerSection needs a definition object');
  if (typeof def.id !== 'string' || !ID_PATTERN.test(def.id)) {
    throw new TypeError(`registerSection: "id" must be letters, digits, dots, dashes (got ${JSON.stringify(def.id)})`);
  }
  if (typeof def.title !== 'string' || def.title.trim() === '')
    throw new TypeError('registerSection: "title" is required');
  if (typeof def.render !== 'function') throw new TypeError('registerSection: "render" must be a function');
  const order = Number.isFinite(def.order) ? Number(def.order) : DEFAULT_ORDER;
  sections.set(def.id, {
    id: def.id,
    title: def.title.trim(),
    icon: typeof def.icon === 'string' ? def.icon : null,
    order,
    gmOnly: def.gmOnly !== false,
    render: def.render,
  });
  announce();
  return () => removeRemoteSection(def.id);
}

/**
 * @param {string} id
 * @returns {boolean} whether there was one to remove
 */
export function removeRemoteSection(id) {
  const had = sections.delete(id);
  if (had) announce();
  return had;
}

/**
 * The sections the Remote should show, in display order.
 * @param {{isGM: boolean}} who
 */
export function listRemoteSections({ isGM }) {
  return [...sections.values()]
    .filter((s) => isGM || !s.gmOnly)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

/**
 * Be told when a section is added or removed.
 * @param {() => void} fn
 * @returns {() => void} stop listening
 */
export function onRemoteSectionsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The controls a registered section builds with. Every element carries the Remote's own classes, so the
 * section inherits the room's type, colour, hover and press behaviour instead of restyling it.
 * @param {Document} doc
 */
export function buildRemoteKit(doc) {
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };
  return Object.freeze({
    /** A small caps header line, with an optional trailing caption. */
    label(text, caption) {
      const wrap = make('div', 'msa-wx-blocklabel');
      wrap.append(make('span', '', text));
      if (caption) wrap.append(make('span', 'msa-wx-hint', caption));
      return wrap;
    },
    /** A full-width caption line. */
    hint: (text) => make('div', 'msa-wx-hint msa-wx-hint--block', text),
    /** A grid of chips (four across). */
    chips: () => make('div', 'msa-wx-chips'),
    /** A wrapping row for loose controls. */
    row: () => make('div', 'msa-ext-row'),
    /** A pill that toggles: `aria-pressed` carries its state, so the Remote styles it. */
    chip(text, { title, pressed = false, onClick } = {}) {
      const btn = make('button', 'msa-wx-chip', text);
      btn.type = 'button';
      if (title) btn.title = title;
      btn.setAttribute('aria-pressed', String(!!pressed));
      if (onClick) btn.addEventListener('click', onClick);
      return btn;
    },
    /** Plain small print. */
    note: (text) => make('div', 'msa-ext-note', text),
  });
}
