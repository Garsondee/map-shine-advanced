/**
 * WINDOW LIGHT's registration — the cascade layer, the live override, the
 * console setter and the FOH/ROH card, in one place.
 *
 * Structurally identical to `specular-registration.js`, which is itself the
 * fifth site following `water-registration.js`'s template
 * (`install()` is a frozen god-object). Everything is injected. This file
 * knows nothing about Foundry settings, the debug panel's internals, or
 * `MapShine`.
 *
 * @module effects/window/window-registration
 */

import { WINDOW, WINDOW_PARAMS, WINDOW_DEBUG_CHANNELS } from './window.js';

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
 *   setWindowLight: (partial?: object) => void, setDebugChannel: (n: number) => object,
 *   getDebugChannel: () => number, getReadout: () => object}}
 */
export function createWindowRegistration({
  effectRegistry,
  deriveEffectLayers,
  readSetting,
  writeSetting,
  moduleId,
  effectEnableKey,
  log,
}) {
  /**
   * ⚠️ `enabled: true` PRE-RESOLVE, matching specular's choice and for the
   * same sharper reason: the effect is inert on any scene with no `_Window`
   * file, so "on" cannot surprise a scene that never opted in; on a scene
   * that DID paint window light, a room where it is flatly dark reads as a
   * bug rather than as a pending resolve.
   */
  let readout = { enabled: true, params: null };

  /** Transient, in-memory tuning (the console setter / the FOH-ROH card) —
   * the highest-precedence param layer. Mirrors specular's `liveOverride`. */
  const liveOverride = {};

  /**
   * WHICH DEBUG INTERMEDIATE IS ON SCREEN (`window.js#WINDOW_DEBUG_CHANNELS`).
   * Deliberately NOT a param — see `SPECULAR_DEBUG_CHANNELS`'s identical
   * reasoning in `specular-registration.js`.
   */
  let debugChannel = 0;

  effectRegistry.register(WINDOW, (resolved) => {
    readout = { enabled: resolved.enabled, params: resolved.params };
  });

  function reapply() {
    const layers = deriveEffectLayers('window', readSetting);
    layers.paramLayers = [liveOverride];
    effectRegistry.resolveAndApply('window', layers);
  }

  /**
   * The viewer's seam. No colour decode here, unlike water's: every param is
   * a scalar, because the COLOUR comes from the mask the author painted
   * rather than from a picker — same absence as specular's, the same
   * authoring model showing up in the plumbing.
   */
  function getRenderState() {
    return { enabled: readout.enabled, params: readout.params ?? {}, debugChannel };
  }

  /**
   * `MapShine.setWindowLight({ strength: 0.5 })` — the console tuner and the
   * card's own onChange. `enabled` writes the PLAYER setting (persisted);
   * every other key lands in the live override (transient).
   * @param {object} [partial]
   */
  function setWindowLight(partial = {}) {
    const p = partial ?? {};
    if (typeof p.enabled === 'boolean') {
      Promise.resolve(writeSetting(moduleId, effectEnableKey('window', 'player'), p.enabled ? 'on' : 'off'))
        .then(() => reapply())
        .catch((err) => log.error('window light enable write/reapply failed:', err));
    }
    let changed = false;
    for (const [key, value] of Object.entries(p)) {
      if (key === 'enabled') continue;
      // Silently accepting an unknown key is how a typo becomes a control
      // that does nothing — `params/no-dead-controls` walls this at build
      // time; this is the runtime path a schema cannot see.
      if (!Object.prototype.hasOwnProperty.call(WINDOW_PARAMS, key)) {
        log.error(`setWindowLight: unknown param '${key}' — see WINDOW_PARAMS in effects/window/window.js`);
        continue;
      }
      liveOverride[key] = value;
      changed = true;
    }
    if (changed) reapply();
  }

  /**
   * `MapShine.setWindowLightDebug(4)` — show one shader intermediate instead
   * of the effect. 0 restores the normal render. See
   * `window.js#WINDOW_DEBUG_CHANNELS` for what each one answers.
   * @param {number} n
   * @returns {{debugChannel: number, channel: object|null}}
   */
  function setDebugChannel(n) {
    const next = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
    const channel = WINDOW_DEBUG_CHANNELS.find((c) => c.n === next) ?? null;
    if (!channel) {
      // Loud rather than clamped — silently snapping to the nearest valid
      // channel would show the author a DIFFERENT intermediate than the one
      // they asked for (`feedback_instruments_must_not_lie`).
      log.error(`setWindowLightDebug: no channel ${next} — valid: ${WINDOW_DEBUG_CHANNELS.map((c) => c.n).join(', ')}`);
      return { debugChannel, channel: WINDOW_DEBUG_CHANNELS.find((c) => c.n === debugChannel) ?? null };
    }
    debugChannel = next;
    return { debugChannel, channel };
  }

  return {
    reapply,
    getRenderState,
    setWindowLight,
    setDebugChannel,
    getDebugChannel: () => debugChannel,
    getReadout: () => readout,
  };
}
