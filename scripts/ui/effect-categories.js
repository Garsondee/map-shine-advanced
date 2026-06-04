/**
 * @fileoverview Top-level Map Shine control panel effect categories.
 * Single source of truth for category IDs, display titles, and accordion order.
 * @module ui/effect-categories
 */

/** @type {readonly string[]} */
export const EFFECT_CATEGORY_ORDER = Object.freeze([
  'gameplay',
  'lighting',
  'atmospheric',
  'surface',
  'particle',
  'post',
  'debug',
]);

/** @type {Readonly<Record<string, string>>} */
export const EFFECT_CATEGORY_TITLES = Object.freeze({
  gameplay: 'Gameplay & Interaction',
  lighting: 'Lighting & Shadows',
  atmospheric: 'Atmosphere & Weather',
  surface: 'Surface & Materials',
  particle: 'Particles & VFX',
  post: 'Camera & Post',
  debug: 'Developer Tools',
  /** Legacy IDs still referenced by schema groups or saved UI state. */
  water: 'Water',
  ash: 'Ash',
  global: 'Camera & Post',
});

/**
 * @param {string} categoryId
 * @returns {string}
 */
export function getEffectCategoryTitle(categoryId) {
  return EFFECT_CATEGORY_TITLES[categoryId] || categoryId;
}
