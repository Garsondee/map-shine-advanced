/**
 * SCENE READINESS — "is this scene ready for Map Shine, and if not, what is
 * missing on which floor?", as one small model the Remote can draw.
 *
 * Author, 2026-11-01: *"If a scene doesn't have the correct masks like
 * _Outdoors then it won't work but currently the GM may be confused as to why
 * it doesn't work. We need the MSA remote to load up automatically and show
 * information if the scene isn't currently MSA ready."* The mask catalog has
 * said since 2026-07-21 that a level with no `_Outdoors` file fails loud and
 * that "a future guided in-app dialogue will walk a GM through painting it";
 * this is the model behind that dialogue.
 *
 * Three states per floor, never two — the same "an instrument must not lie"
 * rule the mask authority's own report follows:
 *   - `ready`   — every required mask was found.
 *   - `missing` — discovery LOOKED and found no file.
 *   - `unknown` — discovery could not look (no browse permission, a CDN URL it
 *                 cannot list, a failed listing). "Couldn't check" is not the
 *                 same news as "isn't there", and the card says which.
 *
 * Pure: plain data in, plain data out. Node-tested.
 *
 * @module scene/scene-readiness
 */

import { MASK_KINDS } from './mask-catalog.js';

/**
 * @typedef {object} ReadinessFloorFacts
 * @property {number} index
 * @property {string} id
 * @property {string} name
 * @property {string[]} hostItemIds - every drawable that can carry this floor's masks.
 * @property {string|null} artSrc - the floor's own background art, or null (a tiles-only floor).
 * @property {string[]} requiredMissing - required authored kind ids with no file from any host.
 * @property {Map<string,string>|null} found - kind id -> URL for the background art's own masks.
 */

/**
 * @typedef {object} ReadinessFloor
 * @property {number} index
 * @property {string} name
 * @property {'ready'|'missing'|'unknown'} status
 * @property {string[]} missingSuffixes - e.g. the outdoors suffix, from the catalog.
 * @property {string} detail - one plain sentence for the card.
 * @property {string|null} artSrc
 * @property {string[]} hasOptional - optional suffixes this floor already has.
 */

/** The required kinds, in catalog order. */
export function requiredKinds() {
  return MASK_KINDS.filter((k) => k.required === true && Array.isArray(k.suffixes) && k.suffixes.length > 0);
}

/** The catalog suffix for a kind id (canonical first), or the id itself. */
export function suffixOf(kindId) {
  return MASK_KINDS.find((k) => k.id === kindId)?.suffixes?.[0] ?? kindId;
}

/**
 * @param {object} facts
 * @param {ReadinessFloorFacts[]} facts.floors
 * @param {{method?:string, failures?:Array<{targetId:string, stage:string, detail:string}>}|null} facts.discovery
 *   null = discovery has not run for this scene.
 * @returns {{checked:boolean, ready:boolean, floors:ReadinessFloor[], headline:string}}
 */
export function buildSceneReadiness({ floors, discovery }) {
  const list = Array.isArray(floors) ? floors : [];
  if (!discovery) {
    return {
      checked: false,
      ready: false,
      floors: [],
      headline: 'Map Shine has not checked this scene for masks yet.',
    };
  }
  const failures = Array.isArray(discovery.failures) ? discovery.failures : [];
  const optional = MASK_KINDS.filter((k) => !k.required && Array.isArray(k.suffixes) && k.suffixes.length > 0);

  const rows = list.map((f) => {
    const missing = Array.isArray(f.requiredMissing) ? f.requiredMissing : [];
    const hosts = new Set(f.hostItemIds ?? []);
    const couldNotLook = failures.some((x) => hosts.has(x.targetId) && (x.stage === 'listing' || x.stage === 'parse'));
    const probed = discovery.method === 'probe' || discovery.method === 'mixed';
    const missingSuffixes = missing.map(suffixOf);
    let status = 'ready';
    let detail = 'Ready.';
    if (missing.length > 0 && hosts.size === 0) {
      status = 'missing';
      detail = 'This floor has no map art for Map Shine to read.';
    } else if (missing.length > 0 && couldNotLook && !probed) {
      status = 'unknown';
      detail = `Couldn't check for ${missingSuffixes.join(', ')}: Map Shine could not list the map's folder.`;
    } else if (missing.length > 0) {
      status = 'missing';
      detail = couldNotLook
        ? `No ${missingSuffixes.join(', ')} found (the folder could not be listed, so Map Shine guessed the file names).`
        : `No ${missingSuffixes.join(', ')} mask yet.`;
    }
    const hasOptional = optional.filter((k) => f.found?.has?.(k.id)).map((k) => k.suffixes[0]);
    return {
      index: f.index,
      name: f.name || `Floor ${f.index + 1}`,
      status,
      missingSuffixes,
      detail,
      artSrc: f.artSrc ?? null,
      hasOptional,
    };
  });

  const notReady = rows.filter((r) => r.status !== 'ready');
  const ready = rows.length > 0 && notReady.length === 0;
  let headline;
  if (rows.length === 0) headline = 'This scene has no floors Map Shine can read.';
  else if (ready) headline = 'This scene is ready for Map Shine.';
  else if (notReady.every((r) => r.status === 'unknown')) headline = "Map Shine couldn't check this scene's masks.";
  else {
    const req = requiredKinds()
      .map((k) => k.suffixes[0])
      .join(', ');
    headline =
      notReady.length === 1 && rows.length === 1
        ? `This map needs its ${req} mask before indoor and outdoor effects work.`
        : `${notReady.length} of ${rows.length} floors need their ${req} mask before indoor and outdoor effects work.`;
  }
  return { checked: true, ready, floors: rows, headline };
}

/**
 * Should the Remote open on its own for this result? Only for a checked scene
 * that is not ready, and not when the GM said "Not now" for this scene.
 * @param {{checked:boolean, ready:boolean, floors:ReadinessFloor[]}} readiness
 * @param {{snoozed:boolean}} opts
 */
export function shouldAutoOpen(readiness, { snoozed }) {
  if (!readiness?.checked || readiness.ready || snoozed) return false;
  return readiness.floors.some((f) => f.status === 'missing' || f.status === 'unknown');
}
