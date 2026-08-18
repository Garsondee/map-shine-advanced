/**
 * ui/rooms/studio/painter-department.js — THE PAINTER DEPARTMENT (U4, docs/
 * holy/UI-Testament.md §5.3, §9): one tile per paintable effect, launching
 * the ALREADY-BUILT full-screen painter (`ui/paint-mode.js`) armed on that
 * effect's own mask. The painter is a document-level modal, never embeddable
 * (`paint-mode.js`'s own root is `position:fixed; inset:0` appended to
 * `document.body`) — this department is a LAUNCHER, not a host in the sense
 * of embedding the painter's DOM inside this one.
 *
 * ⚠️ PAINT → RENDER, ON SAVE (2026-08-18) — "paint fire, see fire" is now
 * genuinely true. `scene/mask-authority.js#ingestPaintedMask` is a THIRD
 * ingest door (alongside file discovery and the VT decode stream), fed by
 * `ui/paint-mode.js`'s own Save action — every effect that reads a painted
 * kind through `maskAuthority.getDerived(kindId, floorIndex)` (all six
 * tiles below, today) picks the change up on its own next read, with zero
 * changes needed in any effect itself. §9's own U4 exit gate ("painting
 * burning fire within five seconds of clicking the tile") is reachable now
 * in the ordinary sense of "paint, then click Save" — NOT yet live
 * mid-stroke before that click, which would mean hooking the painter's own
 * per-frame preview loop rather than its already-explicit Save action, a
 * real, separate, higher-risk follow-up named rather than silently claimed.
 *
 * ⚠️ ONLY SIX TILES, NOT NINE. `scene/mask-catalog.js#MASK_KINDS` has nine
 * entries, but only six effects declare `authoring.paint` (fire, water,
 * window, specular, fluid, vegetation — vegetation covers two masks,
 * tree+bush, as one tile). `shadow`/`outdoors` have no owning effect at all
 * (sun-shadows derives its casters from walls, not a painted mask) — Law 5
 * applies here exactly as it does to `ui/no-dead-axis` for weather: a mask
 * kind nothing reads doesn't get a tile just because the painter's OWN
 * internal kind-picker still lists it.
 *
 * @module ui/rooms/studio/painter-department
 */

import { iconMarkup } from '../../widgets/icon-sprite.js';

/**
 * @param {HTMLElement} container
 * @param {{
 *   listPaintableEffects: () => Array<{id: string, title: string, suffixes: string[], found: boolean}>,
 *   armBrush: (effectId: string) => void,
 * }} ctx
 * @returns {string} department subtitle.
 */
export function renderPainterDepartment(container, ctx) {
  const wrap = document.createElement('div');
  Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '14px' });

  const notice = document.createElement('div');
  Object.assign(notice.style, {
    background: 'var(--bg1)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--r-card, 10px)',
    padding: '10px 12px',
    fontSize: '.74rem',
    color: 'var(--ink2)',
    lineHeight: '1.5',
  });
  notice.innerHTML =
    `<b style="color:var(--ink1)">Paint, then Save.</b> The effect reads your painted stroke the moment you ` +
    `Save — not yet live while you're still dragging the brush (a real, separate follow-up).`;
  wrap.append(notice);

  const grid = document.createElement('div');
  Object.assign(grid.style, {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '10px',
  });

  const effects = ctx.listPaintableEffects();
  for (const effect of effects) {
    const tile = document.createElement('button');
    tile.type = 'button';
    Object.assign(tile.style, {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: '6px',
      textAlign: 'left',
      background: 'var(--bg1)',
      border: '1px solid var(--line)',
      borderRadius: 'var(--r-card, 10px)',
      padding: '12px 14px',
      cursor: 'pointer',
      color: 'var(--ink0)',
    });
    tile.title = `Opens the brush on the floor you are viewing, with ${effect.suffixes.join(' / ')} ready to paint.`;

    const head = document.createElement('span');
    Object.assign(head.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      fontWeight: '650',
      fontSize: '.86rem',
    });
    head.innerHTML = `${iconMarkup('brush')}${effect.title}`;

    const suffixLine = document.createElement('span');
    suffixLine.textContent = effect.suffixes.join(' / ');
    Object.assign(suffixLine.style, { fontSize: '.7rem', color: 'var(--ink2)' });

    const statusLine = document.createElement('span');
    Object.assign(statusLine.style, { fontSize: '.68rem', color: effect.found ? 'var(--ok)' : 'var(--ink2)' });
    statusLine.innerHTML = effect.found
      ? `${iconMarkup('check')}authored on this floor`
      : '— nothing authored on this floor yet';

    tile.append(head, suffixLine, statusLine);
    tile.addEventListener('click', () => ctx.armBrush(effect.id));
    grid.append(tile);
  }
  if (effects.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--ink2); font-size:.8rem; padding:20px';
    empty.textContent = 'No effect declares authoring.paint yet.';
    grid.append(empty);
  }

  wrap.append(grid);
  container.innerHTML = '';
  container.append(wrap);
  return 'paint the masks effects read — six real tiles, live on Save';
}
