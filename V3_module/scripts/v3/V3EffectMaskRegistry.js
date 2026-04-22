/**
 * @fileoverview **Compatibility shim** — thin adapter over
 * {@link module:v3/V3MaskCatalog}.
 *
 * The authoritative declaration of every mask V3 knows about now lives in
 * `V3MaskCatalog.js` (plus the consumer catalog and helper utilities). This
 * file keeps the pre-hub import surface working (`EFFECT_MASKS`, `listMaskIds`,
 * `getMaskDef`, `getEffectMaskRegistry`) so legacy callers and debug helpers
 * continue to resolve while the hub migration proceeds.
 *
 * New code should import from `./V3MaskCatalog.js` directly.
 *
 * @module v3/V3EffectMaskRegistry
 * @deprecated Prefer `V3MaskCatalog` + `V3MaskHub`.
 */

import {
  V3_MASK_CATALOG,
  listAuthoredMaskIds,
  getMaskEntry,
} from "./V3MaskCatalog.js";

/**
 * @typedef {{
 *   suffix: string,
 *   required: boolean,
 *   description: string,
 *   debugChannel?: 'rgba'|'r'|'a',
 * }} MaskDef
 */

/**
 * Legacy-shape map built from the authoritative catalog. Only **authored**
 * masks are exposed here — derived ids (`floorAlpha`, `skyReach`) are hub-only.
 *
 * @type {Readonly<Record<string, MaskDef>>}
 */
export const EFFECT_MASKS = Object.freeze(
  Object.fromEntries(
    listAuthoredMaskIds().map((id) => {
      const entry = V3_MASK_CATALOG[id];
      return [
        id,
        Object.freeze({
          suffix: /** @type {string} */ (entry.suffix),
          required: false,
          description: entry.description ?? "",
          debugChannel: entry.debugChannel ?? "r",
        }),
      ];
    }),
  ),
);

/** @returns {Readonly<Record<string, MaskDef>>} */
export function getEffectMaskRegistry() {
  return EFFECT_MASKS;
}

/**
 * Stable list of authored mask ids (deprecated wrapper over
 * {@link listAuthoredMaskIds}).
 *
 * @returns {string[]}
 */
export function listMaskIds() {
  return listAuthoredMaskIds();
}

/**
 * Lookup an authored mask in legacy shape.
 *
 * @param {string} maskId
 * @returns {MaskDef|null}
 */
export function getMaskDef(maskId) {
  const entry = getMaskEntry(maskId);
  if (!entry || entry.derived || !entry.suffix) return null;
  return {
    suffix: entry.suffix,
    required: false,
    description: entry.description ?? "",
    debugChannel: entry.debugChannel ?? "r",
  };
}
