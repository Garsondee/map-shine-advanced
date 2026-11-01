/**
 * ui/rooms/remote/prep-board.js — THE PREP TAB (2026-11-01 redesign): everything a
 * GM sets before a session and then leaves alone. The test for what belongs here:
 * "would I touch this with the players watching?" — if not, it is Prep.
 *
 *  - THE CLOCK, as two modes (author, 2026-11-01: "One mode for user selection and
 *    one mode for Foundry to drive the clock based on its time"): Free clock — you
 *    set the hour, Play and Speed run it — and World clock — Foundry's own game time
 *    drives it, Jump advances it. The older 'follow' posture reads as World clock.
 *  - Sun path (latitude), the default transition and its pace, player-light rules.
 *  - THE LOOKS LIBRARY — every Look, what it sets, and a Tidy button on any Look
 *    holding a setting the engine no longer has (core/looks-schema.js, "reconcile").
 *  - Scene tools (camera path, tile motion), other modules' sections, developer
 *    tools when switched on, and the support card.
 *
 * @module ui/rooms/remote/prep-board
 */

import { LOOK_FACETS, describeLook, reconcileLook } from '../../../core/looks-schema.js';
import { buildParamControl } from '../../widgets/param-control.js';
import { iconMarkup } from '../../widgets/icon-sprite.js';
import { buildArmButton } from '../../widgets/inline-actions.js';
import { renderTransitionDefaults } from './transition-board.js';
import { renderPlayerLightBoard } from './player-light-board.js';
import { archetypeLabel } from './looks-board.js';
import { PATREON_URL, MAPS_URL } from './more-menu.js';

/** The two clock modes. `posture` is what is stored (world/day-clock.js). */
export const CLOCK_MODES = Object.freeze([
  {
    posture: 'aesthetic',
    label: 'Free clock',
    hint: 'You set the hour: drag the dial, play it, speed it up. Looks set the hour too.',
  },
  {
    posture: 'almanac',
    label: 'World clock',
    hint: "Foundry's game time sets the hour. Jump moves game time on; Looks leave the hour alone.",
  },
]);

/** 'follow' (the old third mode) is Foundry-driven, so it reads as the World clock. */
export function clockModeOf(posture) {
  return posture === 'aesthetic' ? 'aesthetic' : 'almanac';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** One Prep section: a heading, an optional one-line hint, and a body. */
function section(container, icon, title, hint) {
  const sec = el('section', 'msa-prep-sec');
  const head = el('div', 'msa-section-head');
  const t = el('span', 'msa-section-title');
  t.innerHTML = `${iconMarkup(icon)}<span>${title}</span>`;
  head.appendChild(t);
  sec.appendChild(head);
  if (hint) sec.appendChild(el('div', 'msa-hint', hint));
  const body = el('div', 'msa-prep-body');
  sec.appendChild(body);
  container.appendChild(sec);
  return { sec, head, body };
}

/**
 * @param {HTMLElement} container
 * @param {object} ctx
 * @returns {{refreshClock: () => void, refreshTransitions: () => void, refreshLooks: () => void,
 *   playerLight: {refresh: () => void, refreshCarried?: () => void}|null,
 *   extensionHost: HTMLElement, debugHost: HTMLElement, setDevTools: (on: boolean) => void}}
 */
export function renderPrepBoard(container, ctx) {
  const wrap = el('div', 'msa-prep');
  container.appendChild(wrap);

  // ---- the clock -------------------------------------------------------------
  const clock = section(wrap, 'clock', 'Clock');
  const clockSeg = el('div', 'msa-seg-row');
  clockSeg.setAttribute('role', 'group');
  clockSeg.setAttribute('aria-label', 'Who sets the hour');
  const clockHint = el('div', 'msa-hint');
  const clockButtons = CLOCK_MODES.map((m) => {
    const b = el('button', 'msa-seg', m.label);
    b.type = 'button';
    b.title = m.hint;
    b.addEventListener('click', () => {
      ctx.onSetMode?.(m.posture);
      paintClock();
      ctx.onClockModeChanged?.();
    });
    clockSeg.appendChild(b);
    return b;
  });
  clock.body.append(clockSeg, clockHint);
  function paintClock() {
    const mode = clockModeOf(ctx.getPosture?.());
    CLOCK_MODES.forEach((m, i) => clockButtons[i].setAttribute('aria-pressed', String(m.posture === mode)));
    clockHint.textContent = CLOCK_MODES.find((m) => m.posture === mode)?.hint ?? '';
  }
  paintClock();
  if (typeof ctx.getSunLatitude === 'function') {
    clock.body.appendChild(
      buildParamControl(
        'sunLatitude',
        {
          type: 'float',
          min: -90,
          max: 90,
          step: 1,
          default: 30,
          label: 'Sun path (latitude)',
          help: 'How high the sun climbs at noon — 0° passes nearly overhead, ±90° barely clears the horizon.',
        },
        { value: ctx.getSunLatitude(), onChange: (v) => ctx.onSunLatitudeCommit?.(v) }
      )
    );
  }

  // ---- transitions -------------------------------------------------------------
  let transitions = null;
  if (ctx.transitionBoard) {
    const tr = section(
      wrap,
      'frame',
      'Scene transitions',
      'Every load, scene change and floor change plays this, for everyone. Floors play it quicker.'
    );
    transitions = renderTransitionDefaults(tr.body, ctx.transitionBoard);
  }

  // ---- player lights -------------------------------------------------------------
  let playerLight = null;
  if (ctx.playerLight) {
    const pl = section(wrap, 'candle', 'Player lights', 'Which carried lights and vision modes players may pick here.');
    playerLight = renderPlayerLightBoard(pl.body, ctx.playerLight, { compact: true });
  }

  // ---- the Looks library -----------------------------------------------------------
  const lib = section(
    wrap,
    'layers',
    'Looks library',
    'Shared by every map at this table. A Look only changes what it sets, so a Look without Time keeps the hour.'
  );
  const libList = el('div', 'msa-lib');
  lib.body.appendChild(libList);

  function libRow(look) {
    const r = reconcileLook(look, { isKnownArchetype: (id) => Boolean(archetypeLabel(id)) });
    const row = el('div', 'msa-lib-row');
    const main = el('div', 'msa-lib-main');
    const name = el('span', 'msa-lib-name', look.name);
    const sets = el('span', 'msa-lib-sets');
    sets.innerHTML = LOOK_FACETS.filter((f) => r.facets.includes(f.id))
      .map((f) => `<span title="${f.label}">${iconMarkup(f.icon)}</span>`)
      .join('');
    main.append(name, sets);
    const sub = el('div', 'msa-hint', describeLook(look, archetypeLabel));
    main.appendChild(sub);
    row.appendChild(main);
    const actions = el('div', 'msa-lib-actions');
    const outdated = r.stale.length + r.invalid.length;
    if (outdated > 0) {
      const tidy = el('button', 'msa-btn msa-btn--sm', `Tidy (${outdated})`);
      tidy.type = 'button';
      tidy.title = `This Look holds ${outdated} setting(s) Map Shine no longer has (${[...r.stale, ...r.invalid].join(', ')}). They are skipped when it plays; Tidy removes them.`;
      tidy.addEventListener('click', () => void ctx.looks?.tidy?.(look.id));
      actions.appendChild(tidy);
    }
    actions.appendChild(
      buildArmButton({
        label: 'Delete',
        armedLabel: 'Sure?',
        title: 'Delete this Look from every map.',
        armedTitle: 'Click again within a few seconds to delete it everywhere.',
        className: 'msa-btn msa-btn--sm',
        onConfirm: () => void ctx.looks?.remove?.(look.id),
      })
    );
    row.appendChild(actions);
    return row;
  }

  function refreshLooks() {
    const looks = ctx.looks?.list?.() ?? [];
    libList.replaceChildren(
      ...(looks.length > 0 ? looks.map(libRow) : [el('div', 'msa-hint', 'No Looks yet — save one from the Play tab.')])
    );
  }
  refreshLooks();

  // ---- scene tools ---------------------------------------------------------------------
  const tools = section(wrap, 'gear', 'Scene tools');
  const toolRow = el('div', 'msa-look-form-row msa-look-form-row--start');
  for (const [icon, label, fn, title] of [
    ['camera', 'Camera path', ctx.onCameraPath, 'Author a camera fly-through for this scene.'],
    ['play', 'Tile motion', ctx.onOpenTileMotion, "Animate this scene's tiles."],
  ]) {
    if (typeof fn !== 'function') continue;
    const b = el('button', 'msa-btn');
    b.type = 'button';
    b.innerHTML = `${iconMarkup(icon)}<span>${label}</span>`;
    b.title = title;
    b.addEventListener('click', () => fn());
    toolRow.appendChild(b);
  }
  tools.body.appendChild(toolRow);

  // Other modules' sections (extension-sections.js) and the developer strip are
  // drawn by the shell into these hosts.
  const extensionHost = el('div', 'msa-ext-host');
  wrap.appendChild(extensionHost);
  const debugSec = section(wrap, 'flask', 'Developer tools', 'Frame rate and diagnostics. Turn off in the ⋯ menu.');
  const debugHost = debugSec.body;

  // ---- support ---------------------------------------------------------------------------
  const support = el('div', 'msa-support');
  const supportText = el('div', 'msa-support-text');
  supportText.innerHTML =
    '<strong>Map Shine Advanced</strong> is made by Mythica Machina. If it brings your table to life, you can help it grow on Patreon.';
  const supportRow = el('div', 'msa-look-form-row msa-look-form-row--start');
  const patreon = el('a', 'msa-btn msa-btn--patreon');
  patreon.href = PATREON_URL;
  patreon.target = '_blank';
  patreon.rel = 'noopener noreferrer';
  patreon.innerHTML = `${iconMarkup('heart')}<span>Support on Patreon</span>`;
  const maps = el('a', 'msa-btn');
  maps.href = MAPS_URL;
  maps.target = '_blank';
  maps.rel = 'noopener noreferrer';
  maps.innerHTML = `${iconMarkup('map')}<span>Our maps</span>`;
  supportRow.append(patreon, maps);
  support.append(supportText, supportRow);
  wrap.appendChild(support);

  function setDevTools(on) {
    debugSec.sec.hidden = !on;
  }

  return {
    refreshClock: paintClock,
    refreshTransitions: () => transitions?.refresh(),
    refreshLooks,
    playerLight,
    extensionHost,
    debugHost,
    setDevTools,
  };
}
