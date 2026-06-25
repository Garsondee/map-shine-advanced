/**
 * @fileoverview Incremental texture / VRAM overhaul experiment flags.
 *
 * Each flag defaults to legacy (off) behavior. Enable one experiment at a time,
 * test floor switches and frame pacing, then keep or revert before trying the next.
 *
 * Live console API: `MapShine.textureOverhaul.help()`
 *
 * @module core/texture-overhaul-flags
 */

import { createLogger } from './log.js';

const log = createLogger('TextureOverhaul');

export const SKIP_PARTICLE_CHANNEL_PACK_SETTING = 'skipParticleChannelPack';
export const SKIP_CURTAIN_WARM_GATES_SETTING = 'skipCurtainWarmGates';
export const INCREMENTAL_TILE_RESYNC_SETTING = 'incrementalTileResyncOnLevelRedraw';

const MODULE_ID = 'map-shine-advanced';

/** @type {boolean|null} When non-null, overrides the persisted client setting. */
let _runtimeSkipParticleChannelPack = null;
/** @type {boolean|null} When non-null, overrides the persisted client setting. */
let _runtimeSkipCurtainWarmGates = null;
/** @type {boolean|null} When non-null, overrides the persisted client setting. */
let _runtimeIncrementalTileResync = null;

/**
 * Whether `_buildParticleChannelPack` should run (legacy default: true).
 * @returns {boolean}
 */
export function shouldBuildParticleChannelPack() {
  return !_resolveSkipParticleChannelPack();
}

/**
 * Whether warm level revisits may skip curtain shader stability gates.
 * @returns {boolean}
 */
export function shouldShortCircuitCurtainWarmGates() {
  return _resolveSkipCurtainWarmGates();
}

/**
 * Whether native level redraw should reconcile tiles incrementally instead of
 * dispose-all + recreate-all.
 * @returns {boolean}
 */
export function shouldUseIncrementalTileResyncOnLevelRedraw() {
  return _resolveIncrementalTileResync();
}

/**
 * @returns {boolean}
 */
function _resolveIncrementalTileResync() {
  if (_runtimeIncrementalTileResync !== null) {
    return _runtimeIncrementalTileResync;
  }
  try {
    return game?.settings?.get?.(MODULE_ID, INCREMENTAL_TILE_RESYNC_SETTING) === true;
  } catch (_) {
    return false;
  }
}

/**
 * @returns {boolean}
 */
function _resolveSkipParticleChannelPack() {
  if (_runtimeSkipParticleChannelPack !== null) {
    return _runtimeSkipParticleChannelPack;
  }
  try {
    return game?.settings?.get?.(MODULE_ID, SKIP_PARTICLE_CHANNEL_PACK_SETTING) === true;
  } catch (_) {
    return false;
  }
}

/**
 * @returns {boolean}
 */
function _resolveSkipCurtainWarmGates() {
  if (_runtimeSkipCurtainWarmGates !== null) {
    return _runtimeSkipCurtainWarmGates;
  }
  try {
    return game?.settings?.get?.(MODULE_ID, SKIP_CURTAIN_WARM_GATES_SETTING) === true;
  } catch (_) {
    return false;
  }
}

/**
 * Runtime override for live A/B testing (does not persist unless `persist` is true).
 * Pass `null` to clear the override and use the saved client setting again.
 *
 * @param {boolean|null} skip
 * @param {{ persist?: boolean }} [opts]
 * @returns {Promise<ReturnType<typeof getTextureOverhaulStatus>>}
 */
export async function setSkipParticleChannelPack(skip, opts = {}) {
  _runtimeSkipParticleChannelPack = skip === null ? null : !!skip;

  if (opts.persist === true && typeof game?.settings?.set === 'function') {
    await game.settings.set(MODULE_ID, SKIP_PARTICLE_CHANNEL_PACK_SETTING, !!skip);
  }

  if (_resolveSkipParticleChannelPack()) {
    _evictAllParticleChannelPacks();
  }

  return getTextureOverhaulStatus();
}

/**
 * @param {boolean|null} skip Pass `null` to clear runtime override.
 * @param {{ persist?: boolean }} [opts]
 * @returns {Promise<ReturnType<typeof getTextureOverhaulStatus>>}
 */
export async function setSkipCurtainWarmGates(skip, opts = {}) {
  _runtimeSkipCurtainWarmGates = skip === null ? null : !!skip;

  if (opts.persist === true && typeof game?.settings?.set === 'function') {
    await game.settings.set(MODULE_ID, SKIP_CURTAIN_WARM_GATES_SETTING, !!skip);
  }

  return getTextureOverhaulStatus();
}

/**
 * @param {boolean|null} enabled Pass `null` to clear runtime override.
 * @param {{ persist?: boolean }} [opts]
 * @returns {Promise<ReturnType<typeof getTextureOverhaulStatus>>}
 */
export async function setIncrementalTileResyncOnLevelRedraw(enabled, opts = {}) {
  _runtimeIncrementalTileResync = enabled === null ? null : !!enabled;

  if (opts.persist === true && typeof game?.settings?.set === 'function') {
    await game.settings.set(MODULE_ID, INCREMENTAL_TILE_RESYNC_SETTING, !!enabled);
  }

  return getTextureOverhaulStatus();
}

/**
 * @returns {{
 *   skipParticleChannelPack: boolean,
 *   buildParticleChannelPack: boolean,
 *   skipCurtainWarmGates: boolean,
 *   shortCircuitCurtainWarmGates: boolean,
 *   incrementalTileResyncOnLevelRedraw: boolean,
 *   source: { particlePack: string, curtainWarmGates: string, incrementalTileResync: string },
 * }}
 */
export function getTextureOverhaulStatus() {
  const skipParticlePack = _resolveSkipParticleChannelPack();
  const skipCurtainGates = _resolveSkipCurtainWarmGates();
  const incrementalTileResync = _resolveIncrementalTileResync();
  return {
    skipParticleChannelPack: skipParticlePack,
    buildParticleChannelPack: !skipParticlePack,
    skipCurtainWarmGates: skipCurtainGates,
    shortCircuitCurtainWarmGates: skipCurtainGates,
    incrementalTileResyncOnLevelRedraw: incrementalTileResync,
    source: {
      particlePack: _runtimeSkipParticleChannelPack !== null ? 'runtime' : 'setting',
      curtainWarmGates: _runtimeSkipCurtainWarmGates !== null ? 'runtime' : 'setting',
      incrementalTileResync: _runtimeIncrementalTileResync !== null ? 'runtime' : 'setting',
    },
  };
}

function _evictAllParticleChannelPacks() {
  try {
    const comp = window.MapShine?.sceneComposer?._sceneMaskCompositor
      ?? window.MapShine?.gpuSceneMaskCompositor
      ?? null;
    if (comp && typeof comp.evictAllParticleChannelPacks === 'function') {
      const n = comp.evictAllParticleChannelPacks();
      if (n > 0) {
        log.info(`Evicted particlePack from ${n} cached floor(s)`);
      }
    }
  } catch (err) {
    log.warn('evictAllParticleChannelPacks failed', err);
  }
}

/**
 * Install `window.MapShine.textureOverhaul` (idempotent; merges new helpers).
 */
export function exposeTextureOverhaulFlagsApi() {
  try {
    if (typeof window === 'undefined') return;
    const ms = window.MapShine || (window.MapShine = {});

    ms.textureOverhaul = {
      ...(ms.textureOverhaul || {}),
      status: () => getTextureOverhaulStatus(),
      skipParticleChannelPack: (skip, opts) => setSkipParticleChannelPack(skip, opts),
      skipCurtainWarmGates: (skip, opts) => setSkipCurtainWarmGates(skip, opts),
      incrementalTileResync: (enabled, opts) => setIncrementalTileResyncOnLevelRedraw(enabled, opts),
      help: () => {
        console.info(
          'MapShine.textureOverhaul — incremental performance experiments (one at a time)\n'
          + '  .status()                                      — current flag state\n'
          + '  .skipParticleChannelPack(true)                 — skip unused particlePack RT build\n'
          + '  .skipCurtainWarmGates(true)                   — skip shader gates on warm floor revisits\n'
          + '  .incrementalTileResync(true)                  — reconcile tiles on level redraw (no full dispose)\n'
          + '  .incrementalTileResync(true, {persist:true})  — save to client settings\n'
          + '  .incrementalTileResync(null)                   — clear runtime override',
        );
      },
    };
    log.info('Debug helper available: MapShine.textureOverhaul.help()');
  } catch (_) {}
}
