/**
 * WATER's registration — the cascade layer, the live override, the console
 * setter and the FOH/ROH card, in one place.
 *
 * Every other effect (bloom, sun shadows, grade, vegetation) has this same
 * ~50-line block inlined in `boot.js`. Water's lives here instead for the
 * ordinary reason: `install()` is a frozen god-object and adding a fifth copy
 * would have pushed it over, so the split happens as prep rather than the cap
 * being loosened (`feedback_ratchet_proactive_not_reactive`).
 *
 * ⚠️ The four existing copies are a real extraction candidate — four
 * near-identical override/reapply/setter blocks is the exact duplication this
 * project treats as a defect elsewhere. Deliberately NOT done here: migrating
 * four live effects is a behaviour-risk change that has no business riding
 * along with a feature commit (VT-Pan-Viewer-Extraction.md §6's own rule). This
 * module is shaped to be the template when that happens.
 *
 * Everything is injected. This file knows nothing about Foundry settings, the
 * debug panel's internals, or `MapShine` — it is handed the four functions it
 * needs and returns what boot has to hold onto.
 *
 * @module effects/water/water-registration
 */

import { WATER, WATER_PARAMS } from './water.js';
// Intra-zone: the ONE hex→linear decoder, already shared by the candle. A
// second copy is how two effects end up disagreeing about what '#173d47' means.
import { hexToRgb01 } from '../candle-flame-geometry.js';

/**
 * @param {object} args
 * @param {object} args.effectRegistry
 * @param {(effectId: string, readSetting: Function) => object} args.deriveEffectLayers
 * @param {(key: string) => any} args.readSetting
 * @param {(moduleId: string, key: string, value: any) => Promise<any>} args.writeSetting
 * @param {string} args.moduleId
 * @param {(effectId: string, scope: string) => string} args.effectEnableKey
 * @param {{error: Function}} args.log
 * @returns {{reapply: () => void, getRenderState: () => object, setWater: (partial?: object) => void,
 *   getReadout: () => object}}
 */
export function createWaterRegistration({
  effectRegistry,
  deriveEffectLayers,
  readSetting,
  writeSetting,
  moduleId,
  effectEnableKey,
  log,
}) {
  let readout = { enabled: false, params: null };

  /** Transient, in-memory tuning (the console setter / the FOH-ROH card) — the
   * highest-precedence param layer, so live tweaks show at once without being
   * persisted. Mirrors `bloomLiveOverride`. */
  const liveOverride = {};

  effectRegistry.register(WATER, (resolved) => {
    readout = { enabled: resolved.enabled, params: resolved.params };
  });

  function reapply() {
    const layers = deriveEffectLayers('water', readSetting);
    layers.paramLayers = [liveOverride];
    effectRegistry.resolveAndApply('water', layers);
  }

  /**
   * The viewer's seam. Decodes `tint` from its authored hex to linear RGB HERE
   * rather than in the render module: the schema declares a `color` in sRGB
   * because that is what a colour picker speaks, and the shader wants linear —
   * doing the conversion at the one boundary between them keeps every other
   * consumer from having to know which space it is holding.
   */
  function getRenderState() {
    const p = readout.params ?? {};
    return {
      enabled: readout.enabled,
      params: {
        ...p,
        tint: typeof p.tint === 'string' ? hexToRgb01(p.tint) : undefined,
      },
    };
  }

  /**
   * `MapShine.setWater({ opacity: 0.5 })` — the console tuner and the card's
   * own onChange. `enabled` writes the PLAYER setting (persisted); every other
   * key lands in the live override (transient), exactly as `setBloom` does.
   */
  function setWater(partial = {}) {
    const p = partial ?? {};
    if (typeof p.enabled === 'boolean') {
      Promise.resolve(writeSetting(moduleId, effectEnableKey('water', 'player'), p.enabled ? 'on' : 'off'))
        .then(() => reapply())
        .catch((err) => log.error('water enable write/reapply failed:', err));
    }
    let changed = false;
    for (const [key, value] of Object.entries(p)) {
      if (key === 'enabled') continue;
      // Silently accepting an unknown key is how a typo becomes a control that
      // does nothing — the same class `params/no-dead-controls` walls at build
      // time, caught here for the runtime path a schema cannot see.
      if (!Object.prototype.hasOwnProperty.call(WATER_PARAMS, key)) {
        log.error(`setWater: unknown param '${key}' — see WATER_PARAMS in effects/water/water.js`);
        continue;
      }
      liveOverride[key] = value;
      changed = true;
    }
    if (changed) reapply();
  }

  return { reapply, getRenderState, setWater, getReadout: () => readout };
}
