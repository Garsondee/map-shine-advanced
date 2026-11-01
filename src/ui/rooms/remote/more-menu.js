/**
 * ui/rooms/remote/more-menu.js — the Remote header's ⋯ menu (2026-11-01 redesign).
 *
 * Everything a GM needs rarely, gathered in one place so it stops taking room
 * from the controls they use every session: which renderer draws the table, the
 * one-way "stop Map Shine" escape hatch, the camera-path editor, the panel's own
 * size, and the links (report a bug, the map store, Patreon).
 *
 * The two bail-out doors used to be a dropdown in row two and a footer button,
 * with nothing saying how they differed. Here they sit together under one
 * heading, each saying what it does and whether it can be undone.
 *
 * @module ui/rooms/remote/more-menu
 */

import { iconMarkup } from '../../widgets/icon-sprite.js';
import { buildArmButton } from '../../widgets/inline-actions.js';
import { setTip } from '../../widgets/tooltip.js';

export const PATREON_URL = 'https://www.patreon.com/c/MythicaMachina';
export const BUG_URL = 'https://github.com/Garsondee/map-shine-advanced/issues';
export const MAPS_URL = 'https://www.foundryvtt.store/creators/mythica-machina';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(icon, text, href, extraClass = '') {
  const a = el('a', `msa-more-item ${extraClass}`.trim());
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.innerHTML = `${iconMarkup(icon)}<span>${text}</span>`;
  return a;
}

/**
 * @param {HTMLElement} anchor - the ⋯ header button (the menu hangs under it)
 * @param {HTMLElement} host - where the menu element is mounted (inside the card)
 * @param {{getRendererOverride?: () => 'msa'|'foundry',
 *   onRendererOverrideChange?: (v: 'msa'|'foundry') => Promise<void>,
 *   onEngageSafety?: () => void, onCameraPath?: () => void,
 *   scaleStrip?: HTMLElement, getDevTools: () => boolean, onDevTools: (on: boolean) => void}} ctx
 * @returns {{toggle: () => void, close: () => void, isOpen: () => boolean, paintRenderer: (isFoundry: boolean) => void}}
 */
export function installMoreMenu(anchor, host, ctx) {
  const menu = el('div', 'msa-more');
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  host.appendChild(menu);

  // ---- renderer ------------------------------------------------------------
  const rendererHead = el('div', 'msa-more-head', 'Who draws the map');
  const rendererSeg = el('div', 'msa-seg-row');
  rendererSeg.setAttribute('role', 'group');
  rendererSeg.setAttribute('aria-label', 'Renderer for everyone');
  const msaBtn = el('button', 'msa-seg', 'Map Shine');
  const foundryBtn = el('button', 'msa-seg', 'Foundry');
  for (const b of [msaBtn, foundryBtn]) b.type = 'button';
  msaBtn.title = 'Map Shine draws the map for everyone at the table.';
  foundryBtn.title = "Foundry's own renderer draws the map for everyone — switch back any time.";
  rendererSeg.append(msaBtn, foundryBtn);
  const rendererHint = el('div', 'msa-hint', 'For everyone at the table. You can switch back any time.');

  function paintRenderer(isFoundry) {
    msaBtn.setAttribute('aria-pressed', String(!isFoundry));
    foundryBtn.setAttribute('aria-pressed', String(isFoundry));
  }
  async function setRenderer(value) {
    msaBtn.disabled = foundryBtn.disabled = true;
    try {
      await ctx.onRendererOverrideChange?.(value);
      paintRenderer(value === 'foundry');
    } catch (err) {
      setTip(rendererSeg, `Renderer switch failed — ${err?.message ?? err}`);
      try {
        paintRenderer(ctx.getRendererOverride?.() === 'foundry');
      } catch (_) {
        // the setting itself is unreadable; the tooltip above says why
      }
    } finally {
      msaBtn.disabled = foundryBtn.disabled = false;
    }
  }
  msaBtn.addEventListener('click', () => void setRenderer('msa'));
  foundryBtn.addEventListener('click', () => void setRenderer('foundry'));

  const stop = ctx.onEngageSafety
    ? buildArmButton({
        label: 'Stop Map Shine until reload',
        armedLabel: 'Click again to stop it',
        title:
          'Last resort: tears down Map Shine on this client and hands the canvas to Foundry. Only a reload brings it back.',
        armedTitle: 'One-way — Map Shine stops until you reload. Click again within a few seconds.',
        className: 'msa-more-item msa-more-danger',
        onConfirm: () => ctx.onEngageSafety(),
      })
    : null;

  // ---- tools -----------------------------------------------------------------
  const toolsHead = el('div', 'msa-more-head', 'Tools');
  const camera = el('button', 'msa-more-item');
  camera.type = 'button';
  camera.innerHTML = `${iconMarkup('camera')}<span>Camera path editor</span>`;
  camera.addEventListener('click', () => {
    close();
    ctx.onCameraPath?.();
  });
  const sizeRow = el('div', 'msa-more-size');
  sizeRow.append(el('span', '', 'Remote size'));
  if (ctx.scaleStrip) sizeRow.appendChild(ctx.scaleStrip);
  const dev = el('button', 'msa-more-item');
  dev.type = 'button';
  function paintDev() {
    const on = ctx.getDevTools();
    dev.innerHTML = `${iconMarkup('flask')}<span>Developer tools in Prep</span><span class="msa-more-state">${on ? 'On' : 'Off'}</span>`;
    dev.setAttribute('aria-pressed', String(on));
  }
  dev.addEventListener('click', () => {
    ctx.onDevTools(!ctx.getDevTools());
    paintDev();
  });
  paintDev();

  // ---- links -------------------------------------------------------------------
  const linksHead = el('div', 'msa-more-head', 'Map Shine');
  menu.append(
    rendererHead,
    rendererSeg,
    rendererHint,
    ...(stop ? [stop] : []),
    toolsHead,
    camera,
    sizeRow,
    dev,
    linksHead,
    link('heart', 'Support Map Shine on Patreon', PATREON_URL, 'msa-more-patreon'),
    link('map', 'Browse Mythica Machina maps', MAPS_URL),
    link('bug', 'Report a bug', BUG_URL)
  );

  function onOutside(e) {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
  }
  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
  }
  function open() {
    try {
      paintRenderer(ctx.getRendererOverride?.() === 'foundry');
    } catch (_) {
      // read before Foundry's init — the last painted value stands
    }
    paintDev();
    menu.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  }

  return {
    toggle: () => (menu.hidden ? open() : close()),
    close,
    isOpen: () => !menu.hidden,
    paintRenderer,
  };
}
