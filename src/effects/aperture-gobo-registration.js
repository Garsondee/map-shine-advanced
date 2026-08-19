/**
 * APERTURE GOBO's registration — the cascade layer, the live override, the
 * console setter and the render-state seam, in one place.
 *
 * Structurally mirrors `window-registration.js`, with one real difference:
 * this effect owns no mesh, no scene, and no mask, so there is no
 * `getRenderState` pair of mask-authority seams to build alongside it (see
 * `effects/aperture-gobo.js`'s own header — the aperture comes from wall
 * data `effects/lighting/point-light-pool.js` already reads itself via
 * `foundry/scene-walls.js`, not from anything this file hands it). What this
 * DOES hand the pool is the resolved params + a boolean debug flag, the same
 * `{enabled, params}` shape every other render-state seam in this codebase
 * already uses (`getSpecularRenderState`, `getWindowRenderState`, ...).
 *
 * @module effects/aperture-gobo-registration
 */

import { APERTURE_GOBO, APERTURE_GOBO_PARAMS } from './aperture-gobo.js';

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
 *   setApertureGobo: (partial?: object) => void, setDebug: (on: boolean) => object,
 *   getDebug: () => boolean, setDebugChannel: (id: 'off'|'pattern') => object,
 *   getDebugChannel: () => string, getReadout: () => object}}
 */
export function createApertureGoboRegistration({
  effectRegistry,
  deriveEffectLayers,
  readSetting,
  writeSetting,
  moduleId,
  effectEnableKey,
  log,
}) {
  /**
   * ⚠️ `enabled: true` PRE-RESOLVE, matching window/specular's own choice and
   * for the same sharper reason: the effect is inert on any light with no
   * nearby aperture wall (the overwhelming common case on a scene that never
   * placed one), so "on" cannot surprise a scene that has none; a scene that
   * DOES have real windows and sees no pattern reads that as a bug, not as a
   * pending resolve.
   */
  let readout = { enabled: true, params: null };

  /** Transient, in-memory tuning (the console setter / the FOH-ROH card) —
   * the highest-precedence param layer. Mirrors window/specular's `liveOverride`. */
  const liveOverride = {};

  /**
   * Which shader intermediate is on screen instead of the real render:
   * `'off'` (normal) or `'pattern'` (the raw gobo term — white=unmodulated,
   * black=fully shadowed). `docs/planning/Aperture-Gobo.md` §6.0/§10 has the
   * live-safety-net rationale for shipping a pattern-only view at all.
   *
   * RETIRED (round 10, 2026-08-04): `'visibility'` and `'gate-inputs'` — both
   * read the separate visibility-gate pass that no longer exists (the gobo
   * pattern is now baked directly into the light's own MAX-blended
   * illumination/coloration materials — see `point-light-illumination.js`'s
   * own "THE GOBO IS PART OF THIS LIGHT'S OWN FALLOFF" header). Kept as
   * ACCEPTED-BUT-DEPRECATED ids in `VALID_DEBUG_CHANNELS` below rather than
   * removed outright, so an already-saved live-override value doesn't start
   * logging an error every frame — they now simply behave as `'off'` does.
   * @type {'off'|'pattern'}
   */
  let debugChannel = 'off';

  effectRegistry.register(APERTURE_GOBO, (resolved) => {
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
    const layers = deriveEffectLayers('apertureGobo', readSetting);
    layers.paramLayers = [liveOverride];
    effectRegistry.resolveAndApply('apertureGobo', layers);
  }

  /**
   * The viewer's seam — `effects/lighting/point-light-pool.js`'s own
   * `getApertureGoboRenderState` reads exactly this shape every frame.
   */
  function getRenderState() {
    return { enabled: readout.enabled, params: readout.params ?? {}, debugChannel };
  }

  /**
   * `MapShine.setApertureGobo({ strength: 0.5 })` — the console tuner and
   * the card's own onChange. `enabled` writes the PLAYER setting
   * (persisted); every other key lands in the live override (transient).
   * @param {object} [partial]
   */
  function setApertureGobo(partial = {}) {
    const p = partial ?? {};
    if (typeof p.enabled === 'boolean') {
      Promise.resolve(writeSetting(moduleId, effectEnableKey('apertureGobo', 'player'), p.enabled ? 'on' : 'off'))
        .then(() => reapply())
        .catch((err) => log.error('aperture gobo enable write/reapply failed:', err));
    }
    let changed = false;
    for (const [key, value] of Object.entries(p)) {
      if (key === 'enabled') continue;
      // Silently accepting an unknown key is how a typo becomes a control
      // that does nothing — `params/no-dead-controls` walls this at build
      // time; this is the runtime path a schema cannot see.
      if (!Object.prototype.hasOwnProperty.call(APERTURE_GOBO_PARAMS, key)) {
        log.error(`setApertureGobo: unknown param '${key}' — see APERTURE_GOBO_PARAMS in effects/aperture-gobo.js`);
        continue;
      }
      liveOverride[key] = value;
      changed = true;
    }
    if (changed) reapply();
  }

  /**
   * `MapShine.setApertureGoboDebug(true)` — the ORIGINAL boolean toggle,
   * kept for backward compatibility with the existing "Show pattern only"
   * checkbox wiring: `true` maps to the `'pattern'` channel, `false` to
   * `'off'`. Prefer `setDebugChannel` for the third (`'visibility'`) state.
   * @param {boolean} on
   * @returns {{debug: boolean, debugChannel: string}}
   */
  function setDebug(on) {
    debugChannel = on === true ? 'pattern' : 'off';
    return { debug: debugChannel === 'pattern', debugChannel };
  }

  /** Every ACCEPTED channel id — not the same as "every channel that still
   * does something distinct" (`'visibility'`/`'gate-inputs'` are retired,
   * see `debugChannel`'s own doc above, but stay accepted here rather than
   * becoming an error-logging surprise for anyone with an old saved value —
   * `point-light-pool.js`'s own strict `=== 'pattern'` check already treats
   * both the same as `'off'`). `effects/aperture-gobo.js#
   * APERTURE_GOBO_DEBUG_CHANNELS` — the picker UI's own source of truth —
   * only lists the two that still mean something; this set is deliberately
   * WIDER, for backward compatibility only. */
  const VALID_DEBUG_CHANNELS = new Set(['off', 'pattern', 'visibility', 'gate-inputs']);

  /**
   * `MapShine.setApertureGoboDebugChannel('pattern')`. An unrecognised id
   * (a genuine typo, not one of the retired-but-accepted ones above) is a
   * caller bug — falls back to `'off'` rather than leaving a nonsense string
   * in render state; logging here is what makes that fallback loud instead
   * of quiet.
   * @param {'off'|'pattern'} id
   * @returns {{debugChannel: string}}
   */
  function setDebugChannel(id) {
    if (!VALID_DEBUG_CHANNELS.has(id)) {
      log.error(`setApertureGoboDebugChannel: unknown channel '${id}' — falling back to 'off'`);
      debugChannel = 'off';
    } else {
      debugChannel = id;
    }
    return { debugChannel };
  }

  return {
    reapply,
    getRenderState,
    setApertureGobo,
    setDebug,
    getDebug: () => debugChannel === 'pattern',
    setDebugChannel,
    getDebugChannel: () => debugChannel,
    getReadout: () => readout,
  };
}
