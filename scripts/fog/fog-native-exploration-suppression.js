/**
 * Map Shine owns FogExploration persistence via flags; disable Foundry core
 * FogManager DB saves of `explored` so two writers cannot fight.
 */
export function suppressNativeFogExplorationPersistence() {
  try {
    const fog = canvas?.fog;
    if (!fog) return;

    fog.save = async function mapShineSuppressedFogSave() {
      return undefined;
    };
  } catch (_) {
  }
}
