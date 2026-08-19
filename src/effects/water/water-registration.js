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

import { WATER, WATER_PARAMS, WATER_DEBUG_CHANNELS } from './water.js';
// Intra-zone: the ONE hex→linear decoder, already shared by the candle. A
// second copy is how two effects end up disagreeing about what '#173d47' means.
import { hexToRgb01 } from '../candle-flame-geometry.js';
// U6 (docs/holy/UI-Testament.md §9): the read-tracking proxy. Wrapped HERE,
// at getRenderState() — the boundary water-surface-subsystem.js#sync() and
// water-flow-subsystem.js actually read through — never at registration's
// storage handoff above, and never at getReadout() (the UI card's OWN
// accessor, read every render regardless of what the shader touches). See
// param-read-health.js's own header for why the seam matters.
import { wrapForReadTracking } from '../../diag/param-read-health.js';

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
 *   setDebugChannel: (n: number) => object, getDebugChannel: () => number, getReadout: () => object}}
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
  /**
   * ⚠️ `enabled: true` PRE-RESOLVE.
   *
   * This is the state between construction and the first cascade resolve.
   * `false` would mean the surface is HIDDEN for that window, and a hidden river
   * reads as a bug rather than as a pending resolve — so the honest initial value
   * is what the manifest already declares (`enabledFromProfile: 'low'`, i.e. on
   * everywhere). `params: null` still means "no authored values yet", so the
   * render module keeps its own defaults until the real resolve lands.
   *
   * Bloom seeded `false` here until 2026-07-27, and it was not the harmless
   * choice it looked like: nothing ever called `reapplyBloom` outside
   * `MapShine.setBloom`, so the "brief" pre-resolve window lasted the whole
   * session and bloom was off in every scene. Both halves are fixed —
   * `EFFECT_REAPPLIERS` in boot.js runs every effect at ready/settings/scene
   * load, and bloom's seed now matches its manifest like this one does.
   *
   * `perfTier: null` PRE-RESOLVE too, for the identical reason candle's own
   * readout seeds it that way (`boot.js#candleReadout`): the CONSUMER
   * (`water-surface-subsystem.js#sync`) already treats a non-finite tier as
   * "use `WATER_DEFAULT_TIER`", so there is no second fallback to keep in
   * sync here.
   */
  let readout = { enabled: true, params: null, perfTier: null };

  /** Transient, in-memory tuning (the console setter / the FOH-ROH card) — the
   * highest-precedence param layer, so live tweaks show at once without being
   * persisted. Mirrors `bloomLiveOverride`. */
  const liveOverride = {};

  /**
   * WHICH DEBUG INTERMEDIATE IS ON SCREEN (`water.js#WATER_DEBUG_CHANNELS`,
   * Water-Testament W0).
   *
   * Deliberately NOT a param and NOT in `liveOverride`: it is not a property of
   * a material or of the world, it must never be generated onto the FOH/ROH
   * card as a look control, and it must never persist to a setting — a
   * diagnostic that survived a reload would eventually be mistaken for the
   * effect. It travels on the render state beside `enabled`, and dies with the
   * session. Mirrors `specular-registration.js`'s own copy exactly.
   */
  let debugChannel = 0;

  effectRegistry.register(WATER, (resolved) => {
    // `perfTier` (effect-cascade.js#resolveEffectTier, resolved for EVERY
    // effect at the registry door) is carried onto the readout the same way
    // candle's own registration carries it onto `candleReadout` — the surface
    // subsystem's material rebuild is what actually reads it.
    //
    // `maxPerfTier`/`perfTierSource` added 2026-08-19 — the Studio water
    // card (boot.js) has read `readLive().maxPerfTier`/`.perfTierSource`
    // since U6 shipped it, but nothing had ever actually put those two
    // fields on this readout: the tier badge has been silently showing
    // "3" with no "of 4"/source tooltip since the card first went live.
    // Same gap, same fix, now closed for all 13 effects' own readouts at
    // once (see Petition P32's own honest disclosure of this).
    readout = {
      enabled: resolved.enabled,
      params: resolved.params,
      perfTier: resolved.perfTier,
      maxPerfTier: resolved.maxPerfTier,
      perfTierSource: resolved.perfTierSource,
    };
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
   *
   * ⚠️ U6's read-tracking wrap goes HERE, and the shape below is load-bearing,
   * not cosmetic. `params` used to be built as `{...p, tint: ...}` — a plain
   * spread would invoke every own-key GET on `p` in one shot (spread reads
   * `[[OwnPropertyKeys]]` then `[[Get]]`s each), which — if `p` were the
   * tracked proxy — would mark all 24 params "read" on frame one regardless
   * of what `sync()` goes on to actually touch. `Object.create(tracked)` is a
   * PROTOTYPE delegation instead: a key that is never accessed by name is
   * never GET, so laziness survives through to the real per-key reads in
   * `water-surface-subsystem.js#sync()`/`water-flow-subsystem.js`. `tint`
   * itself is read explicitly (`tracked.tint`, not `p.tint`) so decoding it
   * still counts as "the renderer observed this param" — it would otherwise
   * sit forever as an own property on the wrapper, never touching the proxy,
   * and show up as a permanently false "orphaned" param despite being read
   * every single frame.
   */
  function getRenderState() {
    const p = readout.params ?? {};
    const tracked = wrapForReadTracking('water', p);
    const rawTint = tracked.tint;
    return {
      enabled: readout.enabled,
      perfTier: readout.perfTier,
      params: Object.assign(Object.create(tracked), {
        tint: typeof rawTint === 'string' ? hexToRgb01(rawTint) : undefined,
      }),
      debugChannel,
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

  /**
   * `MapShine.setWaterDebug(9)` — show one shader intermediate instead of the
   * effect. 0 restores the normal render. See `water.js#WATER_DEBUG_CHANNELS`
   * for what each one answers.
   *
   * Needs no `reapply()`: it is not part of the cascade at all, and every
   * per-floor surface subsystem reads it off `getRenderState()` on its next
   * `sync()` — which happens every frame, before the draw.
   *
   * @param {number} n
   * @returns {{debugChannel: number, channel: object|null}}
   */
  function setDebugChannel(n) {
    const next = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
    const channel = WATER_DEBUG_CHANNELS.find((c) => c.n === next) ?? null;
    if (!channel) {
      // Loud rather than clamped: silently snapping to the nearest valid
      // channel would show the author a DIFFERENT intermediate than the one
      // they asked for, and they would read the result as an answer about the
      // one they named (`feedback_instruments_must_not_lie`).
      log.error(`setWaterDebug: no channel ${next} — valid: ${WATER_DEBUG_CHANNELS.map((c) => c.n).join(', ')}`);
      return { debugChannel, channel: WATER_DEBUG_CHANNELS.find((c) => c.n === debugChannel) ?? null };
    }
    debugChannel = next;
    return { debugChannel, channel };
  }

  return {
    reapply,
    getRenderState,
    setWater,
    setDebugChannel,
    getDebugChannel: () => debugChannel,
    getReadout: () => readout,
  };
}
