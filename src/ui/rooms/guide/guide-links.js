/**
 * ui/rooms/guide/guide-links.js — which Map Shine Guide page answers each Studio effect card.
 *
 * Each Studio effect card shows a ? that opens this page. Keys are the effect ids boot.js
 * registers (`registerEffectCard('water', …)`); values are guide page ids. The drift test
 * (ui/__tests__/guide.test.mjs) fails if a key is not a registered card or a page does not exist.
 * An effect with no entry simply has no ? until a page covers it.
 *
 * @module ui/rooms/guide/guide-links
 */

export const EFFECT_GUIDE_PAGES = Object.freeze({
  water: 'mask-water',
  fluid: 'mask-fluid',
  fire: 'mask-fire',
  candleFlame: 'mask-fire',
  specular: 'mask-specular',
  window: 'mask-window',
  apertureGobo: 'mask-window',
  vegetation: 'mask-trees',
  leafShed: 'mask-trees',
  prism: 'mask-glints',
  iridescence: 'mask-glints',
  dust: 'mask-air',
  smellyFlies: 'mask-air',
  maggots: 'mask-air',
  fireflies: 'mask-air',
  sunShadows: 'learn-light',
  dynamicRange: 'learn-light',
  grade: 'fix-mood',
  bloom: 'fix-too-bright',
  lens: 'fix-blurry',
  depthOfField: 'fix-blurry',
  precipitation: 'learn-weather',
  clouds: 'learn-weather',
  cloudTops: 'learn-weather',
  wind: 'learn-weather',
  lightning: 'learn-weather',
});
