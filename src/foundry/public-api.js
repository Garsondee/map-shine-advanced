/**
 * @fileoverview foundry/public-api.js — WHAT OTHER MODULES MAY CALL.
 *
 * `game.modules.get('map-shine-advanced').api`, versioned. It exists so a companion module (Footfall, the
 * pathfinding module, is the first) can work WITH Map Shine Advanced without reaching into `MapShine` or `src/`,
 * which are internal and change without notice. Only what is listed here is promised.
 *
 * VERSION 1
 *   api.version                          1
 *   api.floors.prewarm(levelIds)         Prepare floors of the viewed scene in the background, one at a time, without
 *                                        switching to them: their art, masks and GPU pipelines, so the switch itself is
 *                                        quick. Resolves `{ok, prepared: [levelId], skipped: [{levelId, reason}], reason?}`.
 *                                        A real floor switch always wins: prewarming stops (`reason: 'busy'`) the moment
 *                                        one is under way, and may be asked again.
 *   api.floors.isPrepared(levelId)       Has that floor been prepared (by this API, a floor switch, or MSA's own
 *                                        neighbouring-floor prewarm)?
 *   api.remote.registerSection(def)      Add a section to the GM's Remote. `def` and what `render` receives are
 *                                        documented in ui/rooms/remote/extension-sections.js. Returns a function that
 *                                        removes it again.
 *   api.remote.removeSection(id)         Remove one by id.
 *
 * HOOKS (Hooks.callAll)
 *   mapShine.apiReady(api)               The API was installed (it is already on the module, from `init`).
 *   mapShine.floorPrepared(detail)       A floor finished preparing. detail = {sceneId, levelId, floorIndex}.
 *   mapShine.floorPresented(detail)      A floor switch committed: that floor is now what is drawn. Same detail.
 *
 * Nothing here throws into the caller except a malformed `registerSection`, which is a programming error and says so.
 *
 * @module foundry/public-api
 */

import { createLogger } from '../core/log.js';

const log = createLogger('public-api');

const MODULE_ID = 'map-shine-advanced';

/** Bumped only by a change an existing caller would have to adapt to. */
export const PUBLIC_API_VERSION = 1;

/** @param {unknown} value @returns {string[]} a clean list of level ids. */
function levelIdList(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((id) => typeof id === 'string' && id !== '');
}

/**
 * Put the API on the module. Call once, at `init`.
 * @param {{
 *   floors: {prewarm: (levelIds: string[]) => Promise<object>, isPrepared: (levelId: string) => boolean},
 *   remote: {registerSection: (def: object) => () => void, removeSection: (id: string) => boolean},
 * }} parts
 * @returns {object|null} the frozen API, or null when the module record is missing
 */
export function installPublicApi(parts) {
  try {
    const record = game.modules?.get(MODULE_ID);
    if (!record) {
      log.warn(`no module record for ${MODULE_ID}: the public API was not installed.`);
      return null;
    }
    const api = Object.freeze({
      version: PUBLIC_API_VERSION,
      floors: Object.freeze({
        prewarm: async (levelIds) => {
          try {
            return await parts.floors.prewarm(levelIdList(levelIds));
          } catch (err) {
            log.error('floors.prewarm failed:', err);
            return { ok: false, prepared: [], skipped: [], reason: 'error' };
          }
        },
        isPrepared: (levelId) => parts.floors.isPrepared(String(levelId)) === true,
      }),
      remote: Object.freeze({
        registerSection: (def) => parts.remote.registerSection(def),
        removeSection: (id) => parts.remote.removeSection(String(id)),
      }),
    });
    record.api = api;
    Hooks.callAll('mapShine.apiReady', api);
    return api;
  } catch (err) {
    log.error('could not install the public API:', err);
    return null;
  }
}

/**
 * Tell other modules a floor was prepared or presented.
 * @param {'prepared'|'presented'} what
 * @param {{sceneId: string|null, levelId: string, floorIndex: number}} detail
 */
export function announceFloor(what, detail) {
  try {
    Hooks.callAll(what === 'prepared' ? 'mapShine.floorPrepared' : 'mapShine.floorPresented', detail);
  } catch (err) {
    log.error(`a mapShine.floor${what} listener failed:`, err);
  }
}
