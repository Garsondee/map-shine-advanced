/**
 * SHINE's registration — the cascade layer, the live override, the console
 * setter and the FOH/ROH card, in one place.
 *
 * Structurally identical to `water-registration.js`, which that module's own
 * header already flags as the template for the extraction the four inlined
 * copies in `boot.js` are waiting for. This is the fifth site and it goes here
 * for the same reason water's did: `install()` is a frozen god-object.
 *
 * Everything is injected. This file knows nothing about Foundry settings, the
 * debug panel's internals, or `MapShine`.
 *
 * @module effects/specular/specular-registration
 */

import { SPECULAR, SPECULAR_PARAMS } from './specular.js';

/**
 * @param {object} args
 * @param {object} args.effectRegistry
 * @param {(effectId: string, readSetting: Function) => object} args.deriveEffectLayers
 * @param {(key: string) => any} args.readSetting
 * @param {(moduleId: string, key: string, value: any) => Promise<any>} args.writeSetting
 * @param {string} args.moduleId
 * @param {(effectId: string, scope: string) => string} args.effectEnableKey
 * @param {{error: Function}} args.log
 * @returns {{reapply: () => void, getRenderState: () => object,
 *   setSpecular: (partial?: object) => void, getReadout: () => object}}
 */
export function createSpecularRegistration({
  effectRegistry,
  deriveEffectLayers,
  readSetting,
  writeSetting,
  moduleId,
  effectEnableKey,
  log,
}) {
  /**
   * ⚠️ `enabled: true` PRE-RESOLVE, matching water's choice rather than
   * bloom's `false`, and for a sharper version of water's reason.
   *
   * This is the state between construction and the first cascade resolve. The
   * effect is inert on any scene with no `_Specular` file, so "on" cannot
   * surprise a scene that never opted in; and on a scene that DID paint metal,
   * a window where the metal is flatly unlit reads as a bug rather than as a
   * pending resolve. `params: null` still means "no authored values yet", so
   * the render module keeps its own defaults until the real resolve lands.
   */
  let readout = { enabled: true, params: null };

  /** Transient, in-memory tuning (the console setter / the FOH-ROH card) — the
   * highest-precedence param layer, so live tweaks show at once without being
   * persisted. Mirrors `waterLiveOverride`. */
  const liveOverride = {};

  effectRegistry.register(SPECULAR, (resolved) => {
    readout = { enabled: resolved.enabled, params: resolved.params };
  });

  function reapply() {
    const layers = deriveEffectLayers('specular', readSetting);
    layers.paramLayers = [liveOverride];
    effectRegistry.resolveAndApply('specular', layers);
  }

  /**
   * The viewer's seam. No colour decode here, unlike water's: every one of
   * shine's params is a scalar, because the COLOUR comes from the mask the
   * author painted rather than from a picker. That absence is the whole
   * authoring model showing up in the plumbing.
   */
  function getRenderState() {
    return { enabled: readout.enabled, params: readout.params ?? {} };
  }

  /**
   * `MapShine.setSpecular({ polish: 0.3 })` — the console tuner and the card's
   * own onChange. `enabled` writes the PLAYER setting (persisted); every other
   * key lands in the live override (transient), exactly as `setWater` does.
   * @param {object} [partial]
   */
  function setSpecular(partial = {}) {
    const p = partial ?? {};
    if (typeof p.enabled === 'boolean') {
      Promise.resolve(writeSetting(moduleId, effectEnableKey('specular', 'player'), p.enabled ? 'on' : 'off'))
        .then(() => reapply())
        .catch((err) => log.error('specular enable write/reapply failed:', err));
    }
    let changed = false;
    for (const [key, value] of Object.entries(p)) {
      if (key === 'enabled') continue;
      // Silently accepting an unknown key is how a typo becomes a control that
      // does nothing — the same class `params/no-dead-controls` walls at build
      // time, caught here for the runtime path a schema cannot see.
      if (!Object.prototype.hasOwnProperty.call(SPECULAR_PARAMS, key)) {
        log.error(`setSpecular: unknown param '${key}' — see SPECULAR_PARAMS in effects/specular/specular.js`);
        continue;
      }
      liveOverride[key] = value;
      changed = true;
    }
    if (changed) reapply();
  }

  return { reapply, getRenderState, setSpecular, getReadout: () => readout };
}
