/**
 * Map Shine owns fog exploration rendering (FogOfWarEffectV2) and persistence
 * (scene flags). Foundry's native FogManager still ran in parallel:
 * - commit() composited vision into a hidden PIXI sprite every refresh
 * - #throttleExtractPixels() GPU→CPU readback every ~500 ms (~70 ms stalls, HP-1)
 * - save() wrote FogExploration documents (duplicate writer)
 *
 * Foundry fog load (#extractPixels during initialize) completes before canvasReady,
 * so suppressing post-load readbacks does not affect initial isPointExplored data.
 */

import { createLogger } from '../core/log.js';

const log = createLogger('FogNativeSuppression');

/** @type {symbol} */
const PATCH_KEY = Symbol.for('map-shine-advanced.fogNativeSuppression');

/** TextureExtractor.COMPRESSION_MODES.NONE */
const COMPRESSION_NONE = 0;

/**
 * @param {object} fog
 * @returns {{ commitPatched: boolean }}
 */
function getPatchState(fog) {
  if (!fog[PATCH_KEY]) {
    fog[PATCH_KEY] = { commitPatched: false };
  }
  return fog[PATCH_KEY];
}

/**
 * @param {object} fog
 * @returns {boolean} true when the FogExtractor instance is patched
 */
function patchFogExtractor(fog) {
  const extractor = fog?.extractor;
  if (!extractor || extractor._msaFogExtractPatched === true) {
    return extractor?._msaFogExtractPatched === true;
  }

  const nativeExtract = extractor.extract.bind(extractor);

  extractor.extract = async function mapShineSuppressedFogExtract(options = {}) {
    const compression = Number(options?.compression) || 0;

    // Saves are already suppressed; skip BASE64 readback/encode if anything calls through.
    if (compression !== COMPRESSION_NONE) {
      return undefined;
    }

    // Boot-time load extract runs before canvasReady (unpatched). All later NONE
    // extractions (throttled commit, shareFog, etc.) are redundant with MSA fog.
    return {
      pixels: null,
      width: 0,
      height: 0,
      out: options?.out ?? new ArrayBuffer(0),
    };
  };

  extractor._msaFogExtractPatched = true;
  return true;
}

/**
 * Retry until FogManager creates its TextureExtractor during initialize().
 * @param {object} fog
 * @param {number} [attempt=0]
 */
function scheduleFogExtractorPatch(fog, attempt = 0) {
  if (patchFogExtractor(fog)) return;
  if (attempt >= 180) {
    log.warn('FogExtractor patch timed out — native fog readback may still run');
    return;
  }
  requestAnimationFrame(() => scheduleFogExtractorPatch(fog, attempt + 1));
}

/**
 * Disable Foundry FogManager DB saves and redundant commit/readback work.
 * Called from canvasReady (each scene).
 */
export function suppressNativeFogExplorationPersistence() {
  try {
    const fog = canvas?.fog;
    if (!fog) return;

    const state = getPatchState(fog);

    fog.save = async function mapShineSuppressedFogSave() {
      return undefined;
    };

    if (!state.commitPatched) {
      state.commitPatched = true;
      fog.commit = function mapShineSuppressedFogCommit() {
        // FogOfWarEffectV2 accumulates exploration; native sprite is hidden.
        // Skipping commit removes the ~500 ms throttled GPU readback trigger (HP-1)
        // and the redundant PIXI vision→exploration composite each refresh.
        return undefined;
      };
      log.debug('Foundry fog commit() suppressed (MSA owns exploration)');
    }

    scheduleFogExtractorPatch(fog);
  } catch (err) {
    log.warn('Failed to suppress native fog exploration work', err);
  }
}
