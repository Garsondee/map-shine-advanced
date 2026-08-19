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
    // perfTier/maxPerfTier/perfTierSource added 2026-08-19 (Studio
    // effects-population gap-audit) -- `resolved` already carries all
    // three (registry.js's own ResolvedEffect typedef); this readout had
    // captured none of them before the Studio card started wanting one.
    readout = {
      enabled: resolved.enabled,
      params: resolved.params,
      perfTier: resolved.perfTier,
      maxPerfTier: resolved.maxPerfTier,
      perfTierSource: resolved.perfTierSource,
    };
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
 * How fluid asks the mask authority for its files — PER ITEM, not per floor.
 *
 * ============================================================================
 * ⚠️ THIS SEAM IS THE BUG THAT MADE THE EFFECT RENDER NOTHING (2026-07-26)
 * ============================================================================
 * The first version asked `authoredStatus(levelId, 'fluid')`, copying
 * `water-seams.js` and `specular-seams.js`. Those are right for THEM: a river
 * and a metal floor are painted into a level's own background art, and that is
 * exactly the case `authoredStatus`'s own doc says it covers — *"a convenience
 * wrapper for the single most common case, this LEVEL's own BACKGROUND file"*.
 *
 * **Glass tubes are painted on TILES.** The author's map has them on an
 * overhead tile; V2's `FluidEffectV2` walked `canvas.scene.tiles.contents` for
 * exactly this reason. Through the background-only door a tile's mask is
 * invisible, so the lookup returned null on every frame, the mesh never became
 * visible, and NOTHING ANYWHERE ERRORED — the failure mode this project names
 * `feedback_seam_default_hides_unwired`.
 *
 * `keyhole-mask-any-item-decision` already said so as standing doctrine:
 * *every mask attaches to ANY item — tile, level background, or level
 * foreground, symmetrically, for EVERY effect.* The door for that is
 * `authoredStatusForItem`, and this seam now uses it for every item on the
 * floor, background and tile alike.
 *
 * @param {object} args
 * @param {object} args.maskAuthority - `scene/mask-authority.js`'s instance.
 * @param {() => Array<object>} args.getItems - the scene's current item list. A
 *   GETTER: it is replaced on every scene load, and capturing the array would
 *   pin the first scene's items forever.
 * @param {() => Array<{index:number, id:string}>|null} args.getFloors
 * @param {(item: object) => Array<{x:number,y:number}>|null} args.getItemCorners -
 *   the item's world-space quad corners, resolved by the caller (which owns the
 *   texture sizes the placement needs). Null when the item's art has not
 *   resolved yet, which simply defers it to a later frame.
 * @param {(item: object) => number|null} args.getItemRenderOrder -
 *   the item's CURRENT `renderOrder` (`scene/layer-order.js#sortByLayer`'s
 *   stamped integer), resolved by the caller for the same reason corners are:
 *   `getItems()` here is boot's own unfiltered `coverItems` list (cover physics
 *   must see every level, not just the viewed one), which never goes through
 *   `sortByLayer` and so never carries a real `renderOrder`. Only the VIEWER's
 *   own draw-list items do. Null defers the item to a later frame, exactly
 *   like a not-yet-resolved corner.
 * @returns {{getFluidMaskItems: (floorIndex: number) => Array<{id:string,url:string,corners:Array,renderOrder:number|null}>}}
 */
export function createFluidSeams({ maskAuthority, getItems, getFloors, getItemCorners, getItemRenderOrder }) {
  return {
    getFluidMaskItems: (floorIndex) => {
      const floors = getFloors() ?? [];
      const floor = floors.find((f) => f.index === floorIndex) ?? floors[floorIndex] ?? null;
      if (!floor?.id) return [];

      const out = [];
      for (const item of getItems() ?? []) {
        if (item.hidden) continue;
        // Which items belong to this floor — the same test `hostsOfFloor` uses
        // inside the authority. A tile declares the levels it is visible on; a
        // level's own art declares its level directly.
        const onFloor =
          item.kind === 'tile'
            ? Array.isArray(item.visibleOnLevelIds) && item.visibleOnLevelIds.includes(floor.id)
            : (item.kind === 'levelBackground' || item.kind === 'levelForeground') && item.levelId === floor.id;
        if (!onFloor) continue;

        // ONE door for every kind of host. `authoredStatusForItem` is keyed by
        // ITEM id and discovery is keyed the same way for backgrounds and tiles
        // alike, so there is no per-kind branch here — which is the whole point
        // of the mask-any-item decision.
        const status = maskAuthority.authoredStatusForItem(item.id, 'fluid');
        if (status.source !== 'authored') continue;

        const corners = getItemCorners(item);
        if (!corners) continue; // art not resolved yet — try again next frame
        out.push({ id: item.id, url: status.url, corners, renderOrder: getItemRenderOrder(item) });
      }
      return out;
    },
  };
}
