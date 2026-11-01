/**
 * THE PAINTER'S MASK LIST — the model (2026-11-01). Author: *"Add a new section
 * to the painter which shows all the _Suffixed textures that the system can
 * take and show the user which ones are currently correctly connected ...
 * 1.) Quickly let users know which masks were valid and loaded and working for
 * the map. 2.) Provide a quick way to swap to a different mask from within the
 * painter quickly."*
 *
 * Pure: one row per paintable mask kind, for ONE floor, saying the true thing
 * about it. The facts come from two places that are kept apart on purpose:
 *   - FILES (boot.js, from the mask authority): was a file discovered beside
 *     this floor's art or on any of its tiles, and — for kinds the authority
 *     decodes itself (`rasterize: true`) — has its content arrived yet.
 *   - PAINT (the painter's own memory): is there painted content on the layer,
 *     and is any of it unsaved.
 * Whether paint alone DRAWS anything is not this file's belief to form — it is
 * `PAINT_REACH`'s (ui/rooms/studio/painter-department.js), read through
 * `paintReachOf`, so the Studio's tiles and this list can never disagree.
 *
 * Only a discovered FILE satisfies a `required` kind (the readiness card's
 * rule, scene/scene-readiness.js): a painted `_Outdoors` draft still leaves the
 * scene not ready, and the row says so rather than turning green.
 *
 * Node-tested in ui/__tests__/mask-list-model.test.mjs; the DOM is
 * ui/paint-mode-mask-list.js.
 *
 * @module ui/mask-list-model
 */

import { paintReachOf } from './rooms/studio/painter-department.js';

/**
 * What each mask is FOR, in a GM's words — the row's name beside its suffix.
 * Exhaustive over the paintable kinds (the test checks), and `labelOf` falls
 * back to the suffix for a kind added later, so a new mask still lists.
 * @type {Readonly<Record<string, string>>}
 */
export const MASK_LABELS = Object.freeze({
  outdoors: 'Indoors and outdoors',
  shadow: 'Painted shadow',
  fire: 'Fire',
  drip: 'Drips',
  flies: 'Flies',
  maggots: 'Maggots',
  fireflies: 'Fireflies',
  dust: 'Dust in the air',
  ash: 'Ash on the ground',
  specular: 'Shine',
  window: 'Window light',
  tree: 'Tree canopy',
  bush: 'Bushes',
  water: 'Water',
  fluid: 'Fluid tubes',
  prism: 'Prism glass',
  iridescence: 'Iridescence',
});

/** @param {{id:string, suffixes:string[]}} kind */
export function labelOf(kind) {
  return MASK_LABELS[kind.id] ?? kind.suffixes?.[0] ?? kind.id;
}

/** The last part of a URL, decoded — "Docklands_Outdoors.webp". */
export function fileNameOf(url) {
  if (typeof url !== 'string' || !url) return '';
  const last = url.split('?')[0].split('/').pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last; // a malformed %-escape: show it as written rather than nothing
  }
}

/**
 * @typedef {object} FloorMaskFacts
 * @property {boolean} checked - mask discovery has run for this scene.
 * @property {boolean} [failed] - discovery could not list one of the folders,
 *   so "no file" may only mean "could not look".
 * @property {Record<string, {url: string|null, loaded: boolean|null}>} kinds -
 *   per kind id: the discovered file (any host of the floor), and whether its
 *   content has been decoded — `null` for kinds the authority does not decode
 *   (their effect reads the file itself).
 */

/**
 * @typedef {object} MaskListRow
 * @property {string} id
 * @property {string} suffix
 * @property {string} label
 * @property {boolean} required
 * @property {boolean} active - the layer the painter is on.
 * @property {boolean} unsaved - this layer has edits not yet saved.
 * @property {'file'|'loading'|'painted'|'missing'|'none'|'unknown'} status
 * @property {'ok'|'wait'|'warn'|'bad'|'off'} tone
 * @property {string} text - the short status, shown on the row.
 * @property {string} detail - the longer why, shown on hover.
 */

/**
 * @param {object} args
 * @param {ReadonlyArray<{id:string, suffixes:string[], required?:boolean, rasterize?:boolean}>} args.kinds
 * @param {FloorMaskFacts|null} args.facts - null = no scene facts at all.
 * @param {Record<string, {painted?: boolean, unsaved?: boolean}>} [args.paint] - per kind id.
 * @param {string} [args.activeKind]
 * @returns {{rows: MaskListRow[], summary: string, tone: 'ok'|'warn'|'bad'|'off'}}
 */
export function buildMaskList({ kinds, facts, paint = {}, activeKind = null }) {
  const rows = kinds.map((kind) => rowFor(kind, facts, paint[kind.id] ?? {}, activeKind));
  // The required kind leads; everything else keeps catalog order, so a row is
  // always in the same place when you come back to switch to it.
  rows.sort((a, b) => Number(b.required) - Number(a.required));
  return { rows, ...summarize(rows, facts) };
}

function rowFor(kind, facts, paint, activeKind) {
  const suffix = kind.suffixes?.[0] ?? kind.id;
  const base = {
    id: kind.id,
    suffix,
    label: labelOf(kind),
    required: !!kind.required,
    active: kind.id === activeKind,
    unsaved: !!paint.unsaved,
  };
  const fact = facts?.kinds?.[kind.id] ?? null;
  const file = fact?.url ?? null;
  if (file) {
    const name = fileNameOf(file);
    if (fact.loaded === false) {
      return {
        ...base,
        status: 'loading',
        tone: 'wait',
        text: 'File found — loading',
        detail: `${name} was found and is still being read in.`,
      };
    }
    return {
      ...base,
      status: 'file',
      tone: 'ok',
      text: paint.unsaved ? 'File connected — you are changing it' : 'File connected',
      detail:
        fact.loaded === true
          ? `${name} is loaded and in use on this floor.`
          : `${name} was found beside the map; its effect reads it directly.`,
    };
  }
  const reach = paintReachOf([kind.id]);
  if (paint.painted) {
    if (kind.required) {
      return {
        ...base,
        status: 'painted',
        tone: 'warn',
        text: 'Painted — save it next to the map',
        detail:
          `Map Shine needs a real ${suffix} file for this floor. Your painting is kept, but the map is ` +
          'not ready until you use ⬆ Save next to map.',
      };
    }
    if (paint.unsaved) {
      return {
        ...base,
        status: 'painted',
        tone: 'warn',
        text: 'Painted — not saved yet',
        detail: `Save to keep it. ${reach.why}`,
      };
    }
    if (reach.reach === 'renders') {
      return { ...base, status: 'painted', tone: 'ok', text: 'Painted — in use', detail: reach.why };
    }
    return {
      ...base,
      status: 'painted',
      tone: 'warn',
      text: reach.reach === 'partial' ? 'Painted — partly used' : 'Painted — needs a file',
      detail: `${reach.why} Use ⬆ Save next to map to make it a file.`,
    };
  }
  if (!facts?.checked) {
    return {
      ...base,
      status: 'unknown',
      tone: 'off',
      text: 'Not checked yet',
      detail: 'Map Shine has not looked for mask files on this scene yet.',
    };
  }
  if (kind.required) {
    return {
      ...base,
      status: 'missing',
      tone: 'bad',
      text: facts.failed ? 'Missing? (couldn’t look)' : 'Missing — needed',
      detail:
        `Map Shine needs a ${suffix} mask to know which parts of the map are indoors. ` +
        (facts.failed ? 'It could not read the map’s folder, so a file may be there unseen.' : 'No file was found.'),
    };
  }
  return {
    ...base,
    status: 'none',
    tone: 'off',
    text: facts.failed ? 'None found (couldn’t look)' : 'Not used here',
    detail: facts.failed
      ? 'Map Shine could not read the map’s folder, so a file may be there unseen.'
      : `No ${suffix} file or painting on this floor — this effect stays off here.`,
  };
}

function summarize(rows, facts) {
  if (!facts) return { summary: 'No scene loaded.', tone: 'off' };
  // "In use" = something an effect actually reads: a file, or saved painting
  // its effect draws from. Unsaved or file-only painting is not counted.
  const inUse = rows.filter(
    (r) => r.status === 'file' || r.status === 'loading' || (r.status === 'painted' && r.tone === 'ok')
  ).length;
  const missing = rows.filter((r) => r.required && r.status !== 'file' && r.status !== 'loading');
  const used = `${inUse} of ${rows.length} masks in use`;
  if (missing.length) {
    return { summary: `${used} · ${missing.map((r) => r.suffix).join(', ')} still needed`, tone: 'bad' };
  }
  const waiting = rows.some((r) => r.status === 'loading' || r.tone === 'warn');
  return { summary: used, tone: waiting ? 'warn' : 'ok' };
}
