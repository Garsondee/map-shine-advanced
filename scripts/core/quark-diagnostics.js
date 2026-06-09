/**
 * @fileoverview Shared three.quarks labels for Performance Recorder inventory.
 * @module core/quark-diagnostics
 */

/**
 * Tag a particle system for diagnostics exports.
 * @param {import('../libs/three.quarks.module.js').ParticleSystem|null|undefined} system
 * @param {string} source - Logical owner id (weather, smellyFlies, fire, dust, …)
 * @param {string} label - Human-readable system name within the source
 */
export function tagQuarkSystem(system, source, label) {
  if (!system?.emitter) return;
  system.emitter.userData = system.emitter.userData || {};
  if (source) system.emitter.userData.msQuarkSource = source;
  if (label) system.emitter.userData.msQuarkLabel = label;
}

/**
 * Resolve the logical owner of a quarks system for batch partitioning.
 * @param {import('../libs/three.quarks.module.js').ParticleSystem|null|undefined} ps
 * @returns {string}
 */
export function resolveQuarkSource(ps) {
  const ud = ps?.emitter?.userData ?? {};
  if (typeof ud.msQuarkSource === 'string' && ud.msQuarkSource.trim()) {
    return ud.msQuarkSource.trim();
  }

  const owner = ps?.userData?.ownerEffect;
  if (owner) {
    const name = owner.constructor?.name ?? '';
    if (name === 'SmellyFliesEffect') return 'smellyFlies';
    if (name === 'FireEffectV2') return 'fire';
    if (name === 'DustEffectV2') return 'dust';
    if (name === 'AshDisturbanceEffectV2') return 'ashDisturbance';
    if (name === 'WaterSplashesEffectV2') return 'waterSplashes';
    if (name === 'PlayerLightEffectV2') return 'playerLightTorch';
  }

  return 'unknown';
}

/**
 * @param {import('../libs/three.quarks.module.js').ParticleSystem|null|undefined} ps
 * @param {number} index
 * @returns {string}
 */
export function resolveQuarkLabel(ps, index) {
  const ud = ps?.emitter?.userData ?? {};
  if (typeof ud.msQuarkLabel === 'string' && ud.msQuarkLabel.trim()) {
    return ud.msQuarkLabel.trim();
  }
  if (typeof ps?.emitter?.name === 'string' && ps.emitter.name.trim()) {
    return ps.emitter.name.trim();
  }
  const sysUd = ps?.userData ?? {};
  if (sysUd.areaId) return `area/${sysUd.areaId}`;
  if (sysUd.groupId) return `point/${sysUd.groupId}`;
  return `system#${index}`;
}
