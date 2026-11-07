/**
 * ui/rooms/guide/guide-masks.js — the guide's mask cheat sheet, built LIVE from the
 * mask registry so it can never drift from what MSA actually loads.
 *
 * `scene/mask-catalog.js#MASK_KINDS` is the single authority for every suffix MSA
 * reads (and the build already fails if a suffix is typed anywhere else). Its own
 * `meaning` text is written for engineers, so the guide keeps one plain-English
 * line per mask here, keyed by the catalog's id. A drift test
 * (guide/__tests__/guide-drift.test.mjs) fails if a catalog mask has no line here,
 * or a line here names a mask the catalog no longer has.
 *
 * @module ui/rooms/guide/guide-masks
 */

import { MASK_KINDS } from '../../../scene/index.js';
import { escapeHtml } from './guide-markdown.js';

/**
 * One line per mask for artists: what white means, and the guide page about it.
 * `live: false` marks a mask MSA discovers but does not draw yet.
 */
export const MASK_GUIDE = Object.freeze({
  outdoors: { white: 'Open sky. Black is under a roof. Needed on every floor.', page: 'mask-outdoors' },
  shadow: { white: 'Lit. Black would be a painted shadow.', page: 'mask-outdoors', live: false },
  fire: { white: 'Where fire burns. The width of the paint sets the size of each fire.', page: 'mask-fire' },
  drip: { white: 'Where water drips from (roof edges, pipes).', page: 'mask-air' },
  flies: { white: 'Where a swarm of flies hangs. Each blob is one swarm.', page: 'mask-air' },
  maggots: { white: 'Where maggots crawl. Each blob is one colony.', page: 'mask-air' },
  fireflies: { white: 'Where fireflies drift. Each blob is one group.', page: 'mask-air' },
  dust: { white: 'Dusty air. Motes show where window light falls.', page: 'mask-air' },
  ash: { white: 'Ash already lying on the ground.', page: 'mask-air' },
  specular: { white: 'Shiny. The colour you paint is the colour it reflects.', page: 'mask-specular' },
  window: { white: 'The light pattern a window throws on the floor, in colour.', page: 'mask-window' },
  water: { white: 'Water. Brighter is deeper.', page: 'mask-water', paint: 'Greyscale (red is read)' },
  fluid: {
    white: 'Liquid inside tubes and flasks. Brightest end is where it flows from.',
    page: 'mask-fluid',
    paint: 'Greyscale (red is read)',
  },
  tree: { white: 'Not a mask: the tree canopy art itself, with transparency.', page: 'mask-trees' },
  bush: { white: 'Not a mask: the bush art itself, with transparency.', page: 'mask-trees' },
  prism: { white: 'Where light splits into rainbow glints. Colour tints them.', page: 'mask-glints' },
  iridescence: { white: 'Where a surface shimmers with oil-slick colour.', page: 'mask-glints' },
});

const DATA_WORDS = { gray: 'Greyscale', color: 'Colour', rgba: 'Colour + transparency' };

/**
 * The cheat-sheet rows, catalog order.
 * @returns {Array<{id:string, suffix:string, aliases:string[], data:string, required:boolean, white:string, page:string|null, live:boolean}>}
 */
export function maskCheatRows(kinds = MASK_KINDS) {
  return kinds.map((k) => {
    const g = MASK_GUIDE[k.id];
    return {
      id: k.id,
      suffix: k.suffixes[0],
      aliases: k.suffixes.slice(1),
      data: g?.paint ?? DATA_WORDS[k.channels] ?? k.channels,
      required: k.required === true,
      white: g?.white ?? k.meaning,
      page: g?.page ?? null,
      live: g?.live !== false,
    };
  });
}

/** The cheat sheet as an HTML table (the `[[masks-table]]` block). */
export function maskCheatTableHtml(kinds = MASK_KINDS) {
  const rows = maskCheatRows(kinds)
    .map((r) => {
      const name = `<code>${escapeHtml(r.suffix)}</code>${
        r.aliases.length
          ? `<br><small>also ${r.aliases.map((a) => `<code>${escapeHtml(a)}</code>`).join(' ')}</small>`
          : ''
      }`;
      const what = `${escapeHtml(r.white)}${r.required ? ' <strong>Required.</strong>' : ''}${
        r.live ? '' : ' <em>Not used yet.</em>'
      }`;
      const more = r.page ? `<a class="g-link" data-page="${escapeHtml(r.page)}" href="#">Read</a>` : '';
      return `<tr><td>${name}</td><td>${what}</td><td>${escapeHtml(r.data)}</td><td>${more}</td></tr>`;
    })
    .join('');
  return (
    `<div class="g-table-wrap"><table class="g-table"><thead><tr><th>File ending</th><th>White means</th>` +
    `<th>Paint in</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
  );
}
