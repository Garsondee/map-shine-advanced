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

import { SPECULAR, SPECULAR_PARAMS, SPECULAR_LAYER_PARAMS, SPECULAR_DEBUG_CHANNELS } from './specular.js';
import { SPECULAR_LAYER_COUNT } from './specular-render.js';

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
 *   setSpecular: (partial?: object) => void, setDebugChannel: (n: number) => object,
 *   getDebugChannel: () => number, getReadout: () => object}}
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

  /**
   * WHICH DEBUG INTERMEDIATE IS ON SCREEN (`specular.js#SPECULAR_DEBUG_CHANNELS`).
   *
   * Deliberately NOT a param and NOT in `liveOverride`: it is not a property of
   * a material or of the world, it must never be generated onto the FOH/ROH
   * card as a look control, and it must never persist to a setting — a
   * diagnostic that survived a reload would eventually be mistaken for the
   * effect. It travels on the render state beside `enabled`, and dies with the
   * session.
   */
  let debugChannel = 0;

  /**
   * THE PER-LAYER OVERRIDES — `SPECULAR_LAYER_COUNT` shimmer layers (six since
   * Round 19, 2026-08-03; three through Round 18), each with its own eight
   * controls (`specular.js#SPECULAR_LAYER_PARAMS`).
   *
   * Held outside the cascade rather than flattened into it, and the reason is
   * V2's own corpse: it shipped these as twenty-four separate settings with
   * digits in their names (`stripe2Angle`, `stripe3Gaps`) and nobody could tell
   * which layer a slider belonged to. One array of `SPECULAR_LAYER_COUNT`
   * objects keeps the panel able to draw one strip per layer, and keeps the
   * flat schema small regardless of how many layers exist — sized off the
   * SAME constant the render module uses rather than a second hand-typed
   * number, so the two can never silently disagree on how many layers exist.
   *
   * Transient, like the live param override beside it: a layer tweak shows
   * immediately and dies with the session.
   */
  const layerOverrides = Array.from({ length: SPECULAR_LAYER_COUNT }, () => ({}));

  effectRegistry.register(SPECULAR, (resolved) => {
    // perfTier/maxPerfTier/perfTierSource added 2026-08-19, same fix as
    // fluid-registration.js's own readout (see that file's comment).
    readout = {
      enabled: resolved.enabled,
      params: resolved.params,
      perfTier: resolved.perfTier,
      maxPerfTier: resolved.maxPerfTier,
      perfTierSource: resolved.perfTierSource,
    };
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
    return { enabled: readout.enabled, params: readout.params ?? {}, layers: layerOverrides, debugChannel };
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

  /**
   * `MapShine.setSpecularDebug(4)` — show one shader intermediate instead of
   * the effect. 0 restores the normal render. See
   * `specular.js#SPECULAR_DEBUG_CHANNELS` for what each one answers.
   *
   * Needs no `reapply()`: it is not part of the cascade at all, and the viewer
   * reads it off `getRenderState()` on its next `sync` — which happens every
   * frame, before the draw.
   *
   * @param {number} n
   * @returns {{debugChannel: number, channel: object|null}}
   */
  function setDebugChannel(n) {
    const next = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
    const channel = SPECULAR_DEBUG_CHANNELS.find((c) => c.n === next) ?? null;
    if (!channel) {
      // Loud rather than clamped: silently snapping to the nearest valid
      // channel would show the author a DIFFERENT intermediate than the one
      // they asked for, and they would read the result as an answer about the
      // one they named (`feedback_instruments_must_not_lie`).
      log.error(`setSpecularDebug: no channel ${next} — valid: ${SPECULAR_DEBUG_CHANNELS.map((c) => c.n).join(', ')}`);
      return { debugChannel, channel: SPECULAR_DEBUG_CHANNELS.find((c) => c.n === debugChannel) ?? null };
    }
    debugChannel = next;
    return { debugChannel, channel };
  }

  /**
   * `MapShine.setSpecularLayer(1, { streak: 0.4 })` — one shimmer layer's own
   * controls. Validated against `SPECULAR_LAYER_PARAMS` for the same reason
   * `setSpecular` validates against the main schema: silently accepting an
   * unknown key is how a typo becomes a control that does nothing.
   * @param {number} index @param {object} [partial]
   */
  function setSpecularLayer(index, partial = {}) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= layerOverrides.length) {
      log.error(`setSpecularLayer: no layer ${index} — valid: 0..${layerOverrides.length - 1}`);
      return;
    }
    for (const [key, value] of Object.entries(partial ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(SPECULAR_LAYER_PARAMS, key)) {
        log.error(`setSpecularLayer: unknown key '${key}' — see SPECULAR_LAYER_PARAMS`);
        continue;
      }
      layerOverrides[i][key] = value;
    }
  }

  return {
    reapply,
    getRenderState,
    setSpecular,
    setSpecularLayer,
    getLayers: () => layerOverrides,
    setDebugChannel,
    getDebugChannel: () => debugChannel,
    getReadout: () => readout,
  };
}
