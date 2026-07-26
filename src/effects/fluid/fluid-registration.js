/**
 * FLUID's registration — the cascade layer, the live override, the console
 * setter and the seam the viewer reads, in one place.
 *
 * Copies `water-registration.js`, which its own header says was shaped to be
 * exactly this template. Everything is injected: this file knows nothing about
 * Foundry settings, the debug panel's internals, or `MapShine`.
 *
 * @module effects/fluid/fluid-registration
 */

import { FLUID, FLUID_PARAMS } from './fluid.js';
// Intra-zone: the ONE hex→linear decoder, already shared by the candle and
// water. A second copy is how two effects end up disagreeing about what
// '#26f2b3' means.
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
 * @returns {{reapply: () => void, getRenderState: () => object, setFluid: (partial?: object) => void,
 *   getReadout: () => object}}
 */
export function createFluidRegistration({
  effectRegistry,
  deriveEffectLayers,
  readSetting,
  writeSetting,
  moduleId,
  effectEnableKey,
  log,
}) {
  /**
   * `enabled: true` PRE-RESOLVE, matching water's reasoning rather than
   * bloom's: this is the state between construction and the first cascade
   * resolve, and for a decoration that only draws where a mask is painted,
   * "not resolved yet" defaulting to ON costs nothing on a scene with no
   * tubes and avoids a visible gap on one that has them. `params: null` still
   * means "no authored values yet", so the render module keeps its own
   * defaults until the real resolve lands.
   */
  let readout = { enabled: true, params: null };

  /** Transient, in-memory tuning (the console setter / the FOH-ROH card) — the
   * highest-precedence param layer, so live tweaks show at once without being
   * persisted. */
  const liveOverride = {};

  effectRegistry.register(FLUID, (resolved) => {
    readout = { enabled: resolved.enabled, params: resolved.params };
  });

  function reapply() {
    const layers = deriveEffectLayers('fluid', readSetting);
    layers.paramLayers = [liveOverride];
    effectRegistry.resolveAndApply('fluid', layers);
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
   * `MapShine.setFluid({ glow: 3 })` — the console tuner and the card's own
   * onChange. `enabled` writes the PLAYER setting (persisted); every other key
   * lands in the live override (transient).
   */
  function setFluid(partial = {}) {
    const p = partial ?? {};
    if (typeof p.enabled === 'boolean') {
      Promise.resolve(writeSetting(moduleId, effectEnableKey('fluid', 'player'), p.enabled ? 'on' : 'off'))
        .then(() => reapply())
        .catch((err) => log.error('fluid enable write/reapply failed:', err));
    }
    let changed = false;
    for (const [key, value] of Object.entries(p)) {
      if (key === 'enabled') continue;
      // Silently accepting an unknown key is how a typo becomes a control that
      // does nothing — the class `params/no-dead-controls` walls at build time,
      // caught here for the runtime path a schema cannot see.
      if (!Object.prototype.hasOwnProperty.call(FLUID_PARAMS, key)) {
        log.error(`setFluid: unknown param '${key}' — see FLUID_PARAMS in effects/fluid/fluid.js`);
        continue;
      }
      liveOverride[key] = value;
      changed = true;
    }
    if (changed) reapply();
  }

  return { reapply, getRenderState, setFluid, getReadout: () => readout };
}

/**
 * How fluid asks the mask authority for its file.
 *
 * One seam, not water's three: fluid needs only the AUTHORED FILE at its own
 * resolution. It has no coarse-grid consumer (correction #2 — the derivation
 * grid merges adjacent tubes, so the extractor reads the file) and no
 * cross-floor borrow (a tube on another floor is not visible through a hole the
 * way a river is; if that ever changes it is `resolveWaterFloor`'s shape and
 * belongs beside it, not reinvented).
 *
 * @param {object} args
 * @param {object} args.maskAuthority
 * @param {() => Array<{index:number, id:string}>|null} args.getFloors - a
 *   GETTER: the floor list is replaced on every scene load and floor switch,
 *   and capturing the array would pin the first scene's floors forever.
 * @returns {{getFluidMaskUrl: (floorIndex: number) => string|null}}
 */
export function createFluidSeams({ maskAuthority, getFloors }) {
  return {
    getFluidMaskUrl: (floorIndex) => {
      const floors = getFloors() ?? [];
      const floor = floors.find((f) => f.index === floorIndex) ?? floors[floorIndex] ?? null;
      if (!floor?.id) return null;
      const status = maskAuthority.authoredStatus(floor.id, 'fluid');
      return status.source === 'authored' ? status.url : null;
    },
  };
}
