/**
 * ui/widgets/icon-sprite.js — the LANTERN icon set (docs/holy/UI-Testament.md
 * §6), ported verbatim from `tools/ui-mock/index.html`'s own `<symbol>` defs
 * (the mock's header there: "LANTERN draft set"). Every `<path>`/`<circle>`
 * below is copied unchanged — this is a port, not a redraw.
 *
 * Usage mirrors the mock exactly: call {@link installIconSprite} once (it is
 * idempotent, same guard as `ui/tokens.js#installTokens` and `ui/camera-path-
 * dialog.js#injectStyle`), then reference any icon with
 * `<svg class="ico"><use href="#i-sun"/></svg>` — or build that markup with
 * {@link iconMarkup} rather than hand-typing the `i-` prefix at every call
 * site. `.ico` itself (`fill:none; stroke:currentColor; ...`) lives in
 * `ui/tokens.js`'s consumers' own stylesheets, not here — this module owns
 * the icon SHAPES, never their presentation.
 *
 * @module ui/widgets/icon-sprite
 */

const SPRITE_ID = 'msa-icon-sprite';

/**
 * icon name (without the `i-` prefix) → inner SVG markup (`viewBox="0 0 24
 * 24"` for every icon, paths/circles only, no `fill`/`stroke` attributes —
 * those are set once by the `.ico` class via `currentColor`).
 * @type {Readonly<Record<string, string>>}
 */
export const ICONS = Object.freeze({
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/>',
  cloud: '<path d="M6.5 18a4.5 4.5 0 1 1 .8-8.9 6 6 0 0 1 11.4 1.9A3.5 3.5 0 0 1 18 18Z"/>',
  rain: '<path d="M6.5 14a4.5 4.5 0 1 1 .8-8.9 6 6 0 0 1 11.4 1.9A3.5 3.5 0 0 1 18 14Z"/><path d="m8 17-1 3M13 17l-1 3M18 17l-1 3"/>',
  fog: '<path d="M4 10h16M2.5 14h19M5 18h14"/>',
  wind: '<path d="M3 8h9a2.5 2.5 0 1 0-2.4-3M3 12h15a2.5 2.5 0 1 1-2.4 3M3 16h7a2 2 0 1 1-1.9 2.6"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M12 3l-2 2m2-2 2 2M12 21l-2-2m2 2 2-2M4.2 7.5l.7 2.7m-.7-2.7 2.7-.7M19.8 16.5l-.7-2.7m.7 2.7-2.7.7M4.2 16.5l2.7.7m-2.7-.7.7-2.7M19.8 7.5l-2.7-.7m2.7.7-.7 2.7"/>',
  bolt: '<path d="M13 2 5 13.5h5L10.5 22 19 10h-5.5Z"/>',
  ash: '<circle cx="7" cy="16" r="1.2"/><circle cx="12" cy="9" r="1.2"/><circle cx="16.5" cy="15" r="1.2"/><circle cx="10" cy="19.5" r="1.2"/><circle cx="17" cy="5.5" r="1.2"/><path d="M4 5.5c2 1.5 4-1 6 .5"/>',
  fire: '<path d="M12 21c-3.6 0-6-2.3-6-5.6 0-2.7 2-4.6 3.2-6.5.6-1 .9-2 .8-3.4 2.9 1.3 4.4 3 4.6 5.4.8-.4 1.3-1.1 1.5-2.2C17.6 10.3 18 12.5 18 15c0 3.6-2.4 6-6 6Z"/><path d="M12 21c-1.6 0-2.7-1.1-2.7-2.8 0-1.6 1.3-2.6 2.1-3.9.6.9 3.3 1.8 3.3 4 0 1.6-1.1 2.7-2.7 2.7Z"/>',
  water:
    '<path d="M12 3.5c3.5 4.2 6 7.4 6 10.5a6 6 0 1 1-12 0c0-3.1 2.5-6.3 6-10.5Z"/><path d="M9.2 14.5a3 3 0 0 0 2.4 3"/>',
  candle:
    '<path d="M9.5 11h5V21h-5Z"/><path d="M12 8.8c-1.2 0-2-.9-2-2 0-1.3 1.2-2 2-3.8.8 1.8 2 2.5 2 3.8 0 1.1-.8 2-2 2Z"/>',
  dust: '<path d="M12 4.5l.9 2.7 2.7.9-2.7.9-.9 2.7-.9-2.7-2.7-.9 2.7-.9ZM18.5 13l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6ZM7 14.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z"/>',
  eye: '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.6"/>',
  gem: '<path d="M7 4h10l4 5-9 11L3 9Z"/><path d="M3 9h18M12 20 8.5 9l2-5m3.5 16L15.5 9l-2-5"/>',
  bloom:
    '<circle cx="12" cy="12" r="3"/><path d="M12 4v2.5M12 17.5V20M4 12h2.5M17.5 12H20M6.3 6.3l1.8 1.8M15.9 15.9l1.8 1.8M17.7 6.3l-1.8 1.8M8.1 15.9l-1.8 1.8"/>',
  brush:
    '<path d="M15.5 3.5 20 8l-8.5 8.5c-1 1-2.5 1.3-3.7.7-1.5-.7-3.2-.2-4.3.8 1-1.6.4-3-.2-4.6-.5-1.2-.1-2.6.9-3.6Z"/><path d="m12.5 6.5 4.5 4.5"/>',
  map: '<path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6ZM9 4v14m6-12v14"/>',
  clap: '<path d="M3.5 10h17V20h-17ZM3.5 10 5 5l15.5 2.5-1 2.5M8 5.5 6.5 9.7m6-3.2L11 10m6-2.7L15.5 10"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8 13 5.4a7 7 0 0 1 2.3.9l2.6-1 1.8 1.8-1 2.6c.4.7.7 1.5.9 2.3l2.6 1v2.5l-2.6 1a7 7 0 0 1-.9 2.3l1 2.6-1.8 1.8-2.6-1a7 7 0 0 1-2.3.9l-1 2.6h-2.5l-1-2.6a7 7 0 0 1-2.3-.9l-2.6 1-1.8-1.8 1-2.6a7 7 0 0 1-.9-2.3l-2.6-1v-2.5l2.6-1c.2-.8.5-1.6.9-2.3l-1-2.6L7.1 5.3l2.6 1a7 7 0 0 1 2.3-.9l1-2.6Z"/>',
  flask:
    '<path d="M9.5 3h5M10.5 3v5.5L4.8 18a2.2 2.2 0 0 0 2 3.2h10.4a2.2 2.2 0 0 0 2-3.2L13.5 8.5V3"/><path d="M7.5 15h9"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  pin: '<path d="m12 2.8 2.6 5.7 6 .7-4.5 4.1 1.2 6-5.3-3.1-5.3 3.1 1.2-6L3.4 9.2l6-.7Z"/>',
  popout:
    '<path d="M13 5h6v6M19 5l-8 8M10 5H6.5A2.5 2.5 0 0 0 4 7.5v10A2.5 2.5 0 0 0 6.5 20h10a2.5 2.5 0 0 0 2.5-2.5V14"/>',
  play: '<path d="M7 4.5v15L20 12Z"/>',
  shield: '<path d="M12 2.8 20 6v6c0 5-3.4 8.3-8 9.2C7.4 20.3 4 17 4 12V6Z"/>',
  home: '<path d="m3.5 11 8.5-7.5L20.5 11M6 9.5V20h12V9.5"/>',
  gauge: '<path d="M4.5 18.5a9 9 0 1 1 15 0"/><path d="M12 14.5 16.5 9"/><circle cx="12" cy="14.5" r="1.6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.3-3.6 4-5.5 7.5-5.5s6.2 1.9 7.5 5.5"/>',
  palette:
    '<path d="M12 3a9 9 0 0 0 0 18c1.5 0 2.2-.9 2.2-1.9 0-.9-.5-1.4-.5-2.2 0-1.1.9-1.9 2-1.9H17a4.5 4.5 0 0 0 4.5-4.5C21.5 6.4 17.2 3 12 3Z"/><circle cx="7.5" cy="10.5" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16.5" cy="10.5" r="1.2"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5M3 17.5l9 5 9-5"/>',
  chev: '<path d="m9 5 7 7-7 7"/>',
  x: '<path d="M5.5 5.5l13 13m0-13-13 13"/>',
  check: '<path d="m4.5 12.5 5 5L19.5 7"/>',
  warn: '<path d="M12 3.5 22 20H2Z"/><path d="M12 9.5v5M12 17.2v.6"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>',
  frame: '<path d="M7 3.5v17M17 3.5v17M3.5 7h17M3.5 17h17"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.3-5.7M6 3.5v3.2h3.2"/>',
  health: '<path d="M3 12h4l2-5 3.5 10 2.5-7 1.5 2H21"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  camera:
    '<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M9 7l1.5-2.8h3L15 7"/><circle cx="12" cy="13.3" r="3.4"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  calendar:
    '<rect x="3.5" y="5.5" width="17" height="15" rx="2.2"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/><circle cx="8.3" cy="14.3" r="1"/><circle cx="12" cy="14.3" r="1"/><circle cx="15.7" cy="14.3" r="1"/>',
  bug: '<ellipse cx="12" cy="13.5" rx="5" ry="6.2"/><path d="M12 7.3v12.4M7.3 10.2l-3-2M16.7 10.2l3-2M6.5 14h-3M17.5 14h3M7.3 17.8l-3 2M16.7 17.8l3 2M9.3 6 8 4M14.7 6 16 4"/>',
  heart: '<path d="M12 20.3S3.6 14.9 3.6 9.1a5 5 0 0 1 8.4-3.6 5 5 0 0 1 8.4 3.6c0 5.8-8.4 11.2-8.4 11.2Z"/>',
});

/**
 * Install the icon sprite `<svg><defs>` into the current document, once —
 * same idempotent-by-id guard as `ui/tokens.js#installTokens`. Safe to call
 * from every room/widget module that renders an icon.
 */
export function installIconSprite() {
  if (document.getElementById(SPRITE_ID)) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = SPRITE_ID;
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.setAttribute('aria-hidden', 'true');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  for (const [name, inner] of Object.entries(ICONS)) {
    const symbol = document.createElementNS('http://www.w3.org/2000/svg', 'symbol');
    symbol.id = `i-${name}`;
    symbol.setAttribute('viewBox', '0 0 24 24');
    symbol.innerHTML = inner;
    defs.appendChild(symbol);
  }
  svg.appendChild(defs);
  document.body.appendChild(svg);
}

/**
 * `<svg class="ico"><use href="#i-NAME"/></svg>` as a markup string — the
 * same shape the mock's own `icon(id, extra)` JS helper produces, so ported
 * markup-building code needs no translation beyond the import. `extra` is
 * raw attribute text (e.g. `class="ico eff"`) spliced into the `<svg>` tag,
 * matching the mock's own calling convention exactly.
 * @param {string} name - a key of {@link ICONS} (without the `i-` prefix).
 * @param {string} [extra]
 * @returns {string}
 */
export function iconMarkup(name, extra = '') {
  return `<svg class="ico" ${extra}><use href="#i-${name}"/></svg>`;
}
