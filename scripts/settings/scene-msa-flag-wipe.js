/**
 * Wipe all `flags['map-shine-advanced']` on a Scene document (shared by console helpers and enable-reset).
 * @module settings/scene-msa-flag-wipe
 */

/** Foundry scene flag namespace for this module */
export const MSA_SCENE_FLAG_NAMESPACE = 'map-shine-advanced';

/**
 * Fire-and-forget full namespace removal (console / diagnostics).
 * @param {object} scene - Foundry Scene document
 * @param {string} [reason]
 * @returns {boolean} true if an update was queued
 */
export function wipeMapShineAdvancedFlagsFireAndForget(scene, reason = 'wipe') {
  try {
    if (!scene?.id) return false;
    const msaFlags = scene?.flags?.[MSA_SCENE_FLAG_NAMESPACE];
    if (!msaFlags || Object.keys(msaFlags).length === 0) {
      console.log(`MapShine cleanScene: ${scene.name ?? scene.id} -- no MSA flags to clean`);
      return false;
    }
    const flagKeys = Object.keys(msaFlags);
    const flagSize = JSON.stringify(msaFlags).length;
    console.warn(`MapShine cleanScene [${reason}]: wiping ${flagKeys.length} MSA flag keys (${flagSize} bytes) from "${scene.name ?? scene.id}" (${scene.id})`);
    console.warn(`MapShine cleanScene: flag keys being removed: [${flagKeys.join(', ')}]`);

    scene.update({ [`flags.-=${MSA_SCENE_FLAG_NAMESPACE}`]: null }).then(
      () => console.warn(`MapShine cleanScene: successfully wiped MSA flags from "${scene.name ?? scene.id}"`),
      (err) => console.error(`MapShine cleanScene: failed to wipe MSA flags from "${scene.name ?? scene.id}":`, err)
    );
    return true;
  } catch (e) {
    console.error('MapShine cleanScene: error during flag wipe:', e);
    return false;
  }
}

/**
 * Await full removal of the namespace (used before re-seeding defaults on enable).
 * @param {object} scene
 * @param {string} [reason]
 * @returns {Promise<void>}
 */
export async function wipeMapShineAdvancedFlagsAsync(scene, reason = 'wipe-async') {
  if (!scene?.id) return;
  const msaFlags = scene?.flags?.[MSA_SCENE_FLAG_NAMESPACE];
  if (!msaFlags || Object.keys(msaFlags).length === 0) return;
  const flagKeys = Object.keys(msaFlags);
  const flagSize = JSON.stringify(msaFlags).length;
  console.warn(`MapShine wipeAsync [${reason}]: wiping ${flagKeys.length} MSA flag keys (${flagSize} bytes) from "${scene.name ?? scene.id}" (${scene.id})`);
  await scene.update({ [`flags.-=${MSA_SCENE_FLAG_NAMESPACE}`]: null });
}
