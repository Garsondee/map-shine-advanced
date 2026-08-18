/**
 * ui/rooms/studio/painter-department.js — THE PAINTER DEPARTMENT (U4, docs/
 * holy/UI-Testament.md §5.3, §9): one tile per paintable effect, launching
 * the ALREADY-BUILT full-screen painter (`ui/paint-mode.js`) armed on that
 * effect's own mask. The painter is a document-level modal, never embeddable
 * (`paint-mode.js`'s own root is `position:fixed; inset:0` appended to
 * `document.body`) — this department is a LAUNCHER, not a host in the sense
 * of embedding the painter's DOM inside this one.
 *
 * ⚠️ HONEST GAP, NOT SILENTLY CLAIMED. §9's own U4 exit gate — "from a scene
 * with no fire, the author is painting burning fire within five seconds of
 * clicking the tile" — cannot be met by ANY UI, however fast, because the
 * brush's own output has no path into the render pipeline yet. Confirmed by
 * reading `scene/mask-authority.js`'s full ingest API (exactly two doors:
 * scene-file discovery via `foundry/mask-discovery.js`, and the VT pager's
 * own decoded-page stream — neither is the painter) and every reference to
 * the `paintedMasks` scene flag the brush actually writes to (read only by
 * the painter's own re-edit hydration and the export bundler, never by any
 * effect's own render pass). This was flagged as "New to build" in the
 * project's OWN original design doc (`docs/planning/Authoring-and-
 * Distribution.md`'s "brush→DataTexture path... known-but-unbuilt") the same
 * day "paint fire, see fire" was first written down, and nothing has closed
 * it since — a genuine, separate, non-trivial rendering-pipeline feature,
 * not a UI wiring gap this department's own tile grid can paper over. Every
 * tile below is real (it genuinely arms the correct brush, on the correct
 * floor, and Save genuinely persists the stroke to the scene) — what is NOT
 * real yet is what happens to that stroke afterward.
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
    border: '1px dashed var(--fail)',
    borderRadius: 'var(--r-card, 10px)',
    padding: '10px 12px',
    fontSize: '.74rem',
    color: 'var(--ink2)',
    lineHeight: '1.5',
  });
  notice.innerHTML =
    `<b style="color:var(--fail)">◇ Live preview is not wired yet.</b> Painting here opens the real brush ` +
    `and genuinely saves the stroke to this scene — but no effect currently reads a painted mask back at ` +
    `render time (only files discovered on disk do). "Paint it, see it live" is a separate, not-yet-built ` +
    `rendering change, not a gap in this tile grid.`;
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
  return 'paint the masks effects read — six real tiles, one still-unwired render path';
}
