/**
 * THE CRITTERS' REGISTRATION — two effects' cascade layers, live overrides, console
 * setters and render-state seams, in one factory.
 *
 * `boot.js`'s `install()` is a frozen god-object (see `water-registration.js`'s own
 * account), so a new effect does not add another hand-typed block to it: everything is
 * INJECTED here and `boot.js` makes one call. This file knows nothing about Foundry's
 * settings, the debug panel or `MapShine`.
 *
 * Smelly Flies and Fireflies are siblings with the same shape — a painted zone, the same
 * engine, the same readout — so they share the code and differ only by the table row they
 * are built from (`EFFECTS` below). A third critter is a row, not a copy.
 *
 * ============================================================================
 * WHAT THE RENDER STATE CARRIES
 * ============================================================================
 *
 * The viewer's critter subsystems (`critter-subsystem.js`) are given ONE seam each, and
 * that seam answers everything they need about the painted world, so `vt/` never reaches
 * the mask authority or the settings cascade itself:
 *
 *     { enabled, params, perfTier,              ← the resolved cascade (`projectCascadeRenderState`)
 *       floorIndex, elevation,                  ← the viewed floor, and the ground's height on it
 *       gridPx,                                 ← px per grid square, which sizes "a swarm of reference size"
 *       maskGrid, maskVersion }                 ← the painted zone and its change counter
 *
 * `maskGrid` is read ONLY while the effect is on: a disabled effect asks the mask
 * authority nothing.
 *
 * @module effects/critters/critter-registration
 */
import { SMELLY_FLIES, SMELLY_FLIES_PARAMS } from './smelly-flies.js';
import { FIREFLIES, FIREFLIES_PARAMS } from './fireflies.js';
import { projectCascadeRenderState, buildCascadeReadout } from '../effect-readout.js';

/** The two effects, as data. `maskKind` is the id in `scene/mask-catalog.js`. */
const EFFECTS = Object.freeze([
  Object.freeze({ key: 'smellyFlies', manifest: SMELLY_FLIES, params: SMELLY_FLIES_PARAMS, maskKind: 'flies' }),
  Object.freeze({ key: 'fireflies', manifest: FIREFLIES, params: FIREFLIES_PARAMS, maskKind: 'fireflies' }),
]);

/**
 * @param {object} args
 * @param {object} args.effectRegistry
 * @param {(effectId: string, readSetting: Function) => object} args.deriveEffectLayers
 * @param {(key: string) => any} args.readSetting
 * @param {(moduleId: string, key: string, value: any) => Promise<any>} args.writeSetting
 * @param {string} args.moduleId
 * @param {(effectId: string, scope: string) => string} args.effectEnableKey
 * @param {(effectId: string) => {params: object|null, reason: string|null}} args.readSceneEffectParams
 * @param {(effectId: string, patch: object) => Promise<{ok: boolean, reason: string|null}>} args.writeSceneEffectParams
 * @param {{error: Function, warn: Function}} args.log
 * @param {(kind: string, floorIndex: number) => object|null} args.getMaskGrid - the mask authority's
 *   derived grid for a kind on a floor; null (not a throw) when there is none.
 * @param {() => {floorIndex?: number, elevation?: number}|null} args.getFloorContext - the viewed floor.
 * @param {() => number} args.getMaskVersion - the mask authority's change counter.
 * @param {() => number} args.getGridPx - the scene's px per grid square.
 * @returns {Record<'smellyFlies'|'fireflies', {reapply: () => void, set: (partial?: object) => object,
 *   getReadout: () => object, getRenderState: () => object, hasPaint: () => boolean}>}
 */
export function createCritterRegistration({
  effectRegistry,
  deriveEffectLayers,
  readSetting,
  writeSetting,
  moduleId,
  effectEnableKey,
  readSceneEffectParams,
  writeSceneEffectParams,
  log,
  getMaskGrid,
  getFloorContext,
  getMaskVersion,
  getGridPx,
}) {
  /** @type {Record<string, object>} */
  const api = {};

  for (const def of EFFECTS) {
    const { key, manifest, params: schema, maskKind } = def;

    /**
     * Seeded `enabled: false`: the manifest says `enabledFromProfile: 'low'`, so until the
     * first resolve lands there is nothing honest to say, and a `false` seed means a subsystem
     * that is asked in that window does no work rather than guessing.
     */
    let readout = { enabled: false, params: null };
    /** Transient, in-memory tuning (the console setter / the card) — the highest-precedence param layer. */
    const liveOverride = {};

    effectRegistry.register(manifest, (resolved) => {
      readout = buildCascadeReadout(resolved);
    });

    function reapply() {
      const layers = deriveEffectLayers(key, readSetting);
      // Stage B: the scene's own authored params sit between the player's settings and the live override.
      const { params: sceneParams } = readSceneEffectParams(key);
      layers.paramLayers = [sceneParams, liveOverride].filter(Boolean);
      effectRegistry.resolveAndApply(key, layers);
    }

    /**
     * `MapShine.setSmellyFlies({ fliesPerZone: 20 })` — the console tuner and the card's write path.
     * `enabled` writes the PLAYER setting (persisted); every other key lands in the live override
     * (transient) and, unless the param is declared client-scoped, in the scene's own params.
     * @param {object} [partial]
     * @returns {object} the live override, so a console call shows what stuck.
     */
    function set(partial = {}) {
      const p = partial ?? {};
      if (typeof p.enabled === 'boolean') {
        Promise.resolve(writeSetting(moduleId, effectEnableKey(key, 'player'), p.enabled ? 'on' : 'off'))
          .then(() => reapply())
          .catch((err) => log.error(`${key} enable write/reapply failed:`, err));
      }
      let changed = false;
      const scenePatch = {};
      for (const [name, value] of Object.entries(p)) {
        if (name === 'enabled') continue;
        // An unknown key is a typo that would otherwise become a control that does nothing.
        if (!Object.prototype.hasOwnProperty.call(schema, name)) {
          log.error(`set ${key}: unknown param '${name}' — see the ${key} params schema in effects/critters/`);
          continue;
        }
        liveOverride[name] = value;
        if (schema[name]?.scope !== 'client') scenePatch[name] = value;
        changed = true;
      }
      if (changed) {
        Promise.resolve(writeSceneEffectParams(key, scenePatch)).then(
          (result) => {
            if (!result.ok) log.warn(`${key} scene param write not persisted: ${result.reason}`);
          },
          (err) => log.error(`${key} scene param write failed:`, err)
        );
        reapply();
      }
      return { ...liveOverride };
    }

    function viewedFloor() {
      const floor = getFloorContext?.() ?? null;
      return {
        floorIndex: Number.isFinite(floor?.floorIndex) ? floor.floorIndex : 0,
        elevation: Number(floor?.elevation) || 0,
      };
    }

    function getRenderState() {
      const { floorIndex, elevation } = viewedFloor();
      return {
        ...projectCascadeRenderState(readout),
        floorIndex,
        elevation,
        gridPx: getGridPx?.() ?? 100,
        maskGrid: readout.enabled ? (getMaskGrid(maskKind, floorIndex) ?? null) : null,
        maskVersion: getMaskVersion?.() ?? 0,
      };
    }

    api[key] = {
      reapply,
      set,
      getReadout: () => readout,
      getRenderState,
      /** Is there a painted zone on the viewed floor? (The card's status line.) */
      hasPaint: () => Boolean(getMaskGrid(maskKind, viewedFloor().floorIndex)),
    };
  }

  return api;
}
