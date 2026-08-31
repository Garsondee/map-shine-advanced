/**
 * ui/rooms/studio/painter-department.js — THE PAINTER DEPARTMENT (U4, docs/
 * holy/UI-Testament.md §5.3, §9): one tile per paintable effect, launching
 * the ALREADY-BUILT full-screen painter (`ui/paint-mode.js`) armed on that
 * effect's own mask. The painter is a document-level modal, never embeddable
 * (`paint-mode.js`'s own root is `position:fixed; inset:0` appended to
 * `document.body`) — this department is a LAUNCHER, not a host in the sense
 * of embedding the painter's DOM inside this one.
 *
 * ============================================================================
 * ⚠️ PAINT → RENDER IS TRUE FOR SOME KINDS AND FALSE FOR MOST (2026-08-31)
 * ============================================================================
 * This header, and the notice this file renders, used to claim that *"paint
 * fire, see fire" is now genuinely true… every effect that reads a painted
 * kind through `maskAuthority.getDerived(kindId, floorIndex)` (all six tiles
 * below, today) picks the change up on its own next read, with zero changes
 * needed in any effect itself.* **Four of those six tiles never read a
 * painted kind at all**, and the audit that found it also found the failure
 * to be completely silent: a success toast, a saved layer, and no pixel
 * anywhere. That claim is retracted here and replaced by {@link PAINT_REACH},
 * which states the truth per mask kind and is what the tiles now render.
 *
 * The split is the one `effects/fire/fire-spawn-points.js` names in its own
 * header — *"a distribution needs the mask's density; only an edge needs its
 * resolution"* — plus a second axis the brush itself imposes: a
 * `scene/paint-mask.js` MaskGrid is ONE COVERAGE BYTE, so a `channels:
 * 'color'`/`'rgba'` kind cannot be authored by the brush at any resolution.
 * Each gated consumer carries its own deferral note with the full reasoning
 * (`effects/specular/specular-surface-subsystem.js#ensureMaskImage`,
 * `effects/window/window-surface-subsystem.js#ensureMaskImage`,
 * `effects/fluid/fluid-registration.js#createFluidSeams`, and the vegetation
 * URL block in `boot.js`).
 *
 * ⚠️ ONLY SIX TILES, NOT NINE. `scene/mask-catalog.js#MASK_KINDS` has nine
 * entries, but only six effects declare `authoring.paint` (fire, water,
 * window, specular, fluid, vegetation — vegetation covers two masks,
 * tree+bush, as one tile). `shadow`/`outdoors` have no owning effect at all
 * (sun-shadows derives its casters from walls, not a painted mask) — Law 5
 * applies here exactly as it does to `ui/no-dead-axis` for weather: a mask
 * kind nothing reads doesn't get a tile just because the painter's OWN
 * internal kind-picker still lists it. `PAINT_REACH` below still covers all
 * nine, because that picker DOES list all nine and the two tile-less kinds
 * are exactly where a wrong belief has nothing to correct it.
 *
 * @module ui/rooms/studio/painter-department
 */

import { iconMarkup } from '../../widgets/icon-sprite.js';

/**
 * WHAT PAINTING EACH MASK KIND ACTUALLY DOES TODAY — the one place this UI is
 * allowed to form a belief about that, verified against the consumers on
 * 2026-08-31 rather than assumed from the ingest door's existence.
 *
 * `reach` is deliberately three-valued:
 *   'renders'   — the effect reads the authority's composited grid, which
 *                 includes painted sources. Paint alone draws.
 *   'partial'   — some of the effect reads the painted grid and some of it
 *                 still requires a discovered file. Named rather than rounded
 *                 to either neighbour, because rounding is how this file came
 *                 to ship a false claim in the first place.
 *   'file-only' — the effect resolves a real file URL and never consults
 *                 painted content. Paint saves, and nothing renders.
 *
 * Exhaustive over `MASK_KINDS` on purpose (nine entries, including the two
 * with no tile). `paintReachOf` falls back to the PESSIMISTIC verdict for an
 * id absent here and says "not evaluated" out loud, so a tenth kind added to
 * the catalog cannot silently inherit a confident wrong answer — the
 * `feedback_seam_default_hides_unwired` shape, refused by making the default
 * visible instead of merely safe.
 *
 * @type {Readonly<Record<string, {reach: 'renders'|'partial'|'file-only', why: string}>>}
 */
export const PAINT_REACH = Object.freeze({
  // Reads `getDerived('fire', floor)` for both spawn points and light
  // placement — the worked example the whole distinction comes from.
  fire: { reach: 'renders', why: 'Fire reads the painted grid directly — paint it and it burns.' },
  // Reads `getDerived('outdoors', floor)`. No tile (no owning effect), listed
  // for completeness because the painter's own dropdown offers it.
  outdoors: { reach: 'renders', why: 'Indoor/outdoor reads the painted grid directly.' },
  // The body pack floods the painted grid, but `water-surface-subsystem.js#
  // refreshVisibility` gates the visible mesh on `!!loadedUrl` — a discovered
  // file. Painting shapes the shore-distance field and draws no water.
  water: {
    reach: 'partial',
    why: 'Paint feeds the water body and its shoreline distance, but the visible surface still needs a mask file.',
  },
  // Resolves `authoredStatus(...).url`. Grid is R-only, the shader tints by
  // RGB, and the island pack needs real pixels. See the subsystem's own note.
  specular: { reach: 'file-only', why: 'Shine reads the mask file only — it needs full resolution and colour.' },
  // Resolves `authoredStatus(...).url`. The mask IS the light, hue included;
  // a one-byte brush cannot author it. See the subsystem's own note.
  window: {
    reach: 'file-only',
    why: 'Window light reads the mask file only — the mask carries colour a brush cannot paint.',
  },
  // Resolves `authoredStatusForItem(...).url`, per host item. The tube net is
  // extracted from the file's pixels by an explicit earlier correction.
  fluid: { reach: 'file-only', why: 'Tubes read the mask file only — the coarse grid merges tubes together.' },
  // Not `rasterize: true` at all, so no painted grid is ever composited for
  // it; and the consumer wants an RGBA canopy image, not a coverage field.
  tree: { reach: 'file-only', why: 'Canopy reads the mask file only — nothing composites a painted canopy yet.' },
  bush: { reach: 'file-only', why: 'Bushes read the mask file only — nothing composites a painted bush layer yet.' },
  // Not rasterized, and no effect reads it. No tile. The painter offers it.
  shadow: { reach: 'file-only', why: 'Nothing reads this mask yet, painted or otherwise.' },
});

/** Rank used to pick an EFFECT's verdict from its kinds — weakest wins. */
const REACH_RANK = { 'file-only': 0, partial: 1, renders: 2 };

/**
 * One effect's verdict, taken as the WEAKEST of the mask kinds it declares.
 *
 * Vegetation is the only multi-kind tile today (tree + bush). "Weakest wins"
 * is the honest reduction: a tile that painted one of its two kinds usefully
 * and silently dropped the other would be back to claiming something false,
 * and the alternative — a per-kind breakdown inside one tile — is more UI than
 * the one real case justifies while both of vegetation's kinds agree anyway.
 *
 * @param {string[]} kinds - mask-kind ids from the effect's own
 *   `authoring.paint` declaration (never re-derived here — the tree+bush
 *   pairing lives in `effects/vegetation.js` and must stay there).
 * @returns {{reach: 'renders'|'partial'|'file-only', why: string, evaluated: boolean}}
 */
export function paintReachOf(kinds) {
  const list = Array.isArray(kinds) ? kinds : [kinds];
  if (list.length === 0) {
    return { reach: 'file-only', why: 'This effect declares no mask kind — nothing to paint.', evaluated: false };
  }
  let worst = null;
  let evaluated = true;
  for (const id of list) {
    const entry = PAINT_REACH[id];
    if (!entry) {
      // Pessimistic AND loud — see PAINT_REACH's own doc.
      evaluated = false;
      return {
        reach: 'file-only',
        why: `Painting '${id}' has not been evaluated — assume it does not render.`,
        evaluated: false,
      };
    }
    if (!worst || REACH_RANK[entry.reach] < REACH_RANK[worst.reach]) worst = entry;
  }
  return { reach: worst.reach, why: worst.why, evaluated };
}

/**
 * The tile's status line — what is actually on this floor, and whether it will
 * draw. Pure, so `painter-department.test.mjs` can assert the one rule that
 * matters: no combination of inputs may produce copy claiming a painted mask
 * renders when its kind's reach says it does not.
 *
 * @param {{found: boolean, painted: boolean,
 *   reach: 'renders'|'partial'|'file-only'}} args - `found` = a mask FILE was
 *   discovered beside this floor's background art; `painted` = the in-app
 *   brush has laid down non-zero texels here. Two separate facts, kept apart
 *   on purpose (`boot.js#listPaintableEffects`'s own doc says why).
 * @returns {{text: string, tone: 'ok'|'warn'|'idle', icon: 'check'|'warn'|null}}
 */
export function paintStatusLine({ found = false, painted = false, reach = 'file-only' } = {}) {
  if (reach === 'renders') {
    if (found && painted) return { text: 'mask file + your paint — both render', tone: 'ok', icon: 'check' };
    if (found) return { text: 'mask file found on this floor', tone: 'ok', icon: 'check' };
    if (painted) return { text: 'painted on this floor — this renders', tone: 'ok', icon: 'check' };
    return { text: '— nothing here yet; painting renders straight away', tone: 'idle', icon: null };
  }
  if (reach === 'partial') {
    if (painted && !found)
      return { text: 'painted — but the visible surface needs a mask file', tone: 'warn', icon: 'warn' };
    if (found) return { text: 'mask file found on this floor', tone: 'ok', icon: 'check' };
    return { text: '— nothing here yet; painting alone is not enough', tone: 'idle', icon: null };
  }
  // file-only
  if (painted && !found)
    return { text: 'painted — but NOT rendered; this effect reads the file', tone: 'warn', icon: 'warn' };
  if (found && painted) return { text: 'mask file found — your paint is ignored', tone: 'warn', icon: 'warn' };
  if (found) return { text: 'mask file found on this floor', tone: 'ok', icon: 'check' };
  return { text: '— nothing here yet; this effect needs a mask file', tone: 'idle', icon: null };
}

/** Status-line colour per tone. Kept beside `paintStatusLine` so a new tone
 * cannot be introduced without a colour, which is how a status line ends up
 * silently inheriting `--ink0`. */
const TONE_COLOR = { ok: 'var(--ok)', warn: 'var(--warn)', idle: 'var(--ink2)' };

/**
 * @param {HTMLElement} container
 * @param {{
 *   listPaintableEffects: () => Array<{id: string, title: string, suffixes: string[],
 *     kinds?: string[], found: boolean, painted?: boolean}>,
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
    `<b style="color:var(--ink1)">Paint, then Save.</b> Saving hands your strokes to the mask authority — ` +
    `not yet live while you're still dragging the brush (a real, separate follow-up).<br>` +
    `<b style="color:var(--warn)">Not every effect can read a painted mask.</b> Each tile says which it is. ` +
    `An effect marked as reading the mask file wants a full-resolution image beside the map art — ` +
    `painting it saves your strokes and renders nothing, so the tile warns instead of pretending.`;
  wrap.append(notice);

  const grid = document.createElement('div');
  Object.assign(grid.style, {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '10px',
  });

  const effects = ctx.listPaintableEffects();
  for (const effect of effects) {
    // The effect's own declared kinds drive the verdict. An older ctx that
    // predates `kinds` degrades to the pessimistic "not evaluated" branch of
    // `paintReachOf` rather than to a confident wrong claim.
    const verdict = paintReachOf(effect.kinds ?? []);
    const status = paintStatusLine({ found: effect.found, painted: effect.painted === true, reach: verdict.reach });

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
    tile.title =
      `Opens the brush on the floor you are viewing, with ${effect.suffixes.join(' / ')} ready to paint. ` +
      verdict.why;

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

    // THE LINE THIS WHOLE FILE EXISTS TO GET RIGHT — what painting this tile
    // will actually do, stated before the click rather than discovered after
    // a save that drew nothing.
    const reachLine = document.createElement('span');
    reachLine.textContent = verdict.why;
    Object.assign(reachLine.style, {
      fontSize: '.68rem',
      lineHeight: '1.4',
      color: verdict.reach === 'renders' ? 'var(--ink1)' : 'var(--warn)',
    });

    const statusLine = document.createElement('span');
    Object.assign(statusLine.style, { fontSize: '.68rem', color: TONE_COLOR[status.tone] });
    statusLine.innerHTML = `${status.icon ? iconMarkup(status.icon) : ''}${status.text}`;

    tile.append(head, suffixLine, reachLine, statusLine);
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
  return 'paint the masks effects read — each tile says whether paint reaches it';
}
