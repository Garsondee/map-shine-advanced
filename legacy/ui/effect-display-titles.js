/**
 * @fileoverview Display titles for Tweakpane categories, effects, and panel sections.
 * Single source of truth for emoji-prefixed folder headers in the control panel.
 * @module ui/effect-display-titles
 */

/** @type {Readonly<Record<string, string>>} */
export const EFFECT_DISPLAY_TITLES = Object.freeze({
  weather: '🌧️ Precipitation & Global Weather',
  'scene-wind': '💨 Wind',
  'player-light': '🔦 Player Light',
  fog: '🌫️ Fog of War',
  visionMode: '👁️ Vision Mode',
  grid: '📐 Grid',
  'floor-depth-blur': '🔍 Floor Depth Blur',
  contextualSceneGrade: '🎨 Contextual Scene Grade',
  lighting: '💡 Light Physics',
  'sky-color': '🌅 Sky Environment',
  windowLight: '🪟 Window Light',
  bloom: '✨ Bloom Highlights',
  'shadow-casters': '🌑 Shadow Caster Systems',
  'overhead-shadows': '☁️ Overhead',
  'building-shadows': '🏢 Building',
  'sky-reach-shadows': '🏔️ Sky Reach',
  'painted-shadows': '🖌️ Painted',
  'atmospheric-fog': '🌁 Atmospheric Fog & Air',
  'cloud-systems': '☁️ Cloud Systems',
  lightning: '⚡ Overhead Lightning Bolts',
  'weather-lightning': '🌩️ Atmospheric Flash Lighting',
  'ash-clouds': '🌫️ Ash Ground Clouds',
  cloud: '☁️ Sprite Clouds',
  specular: '💎 Metallic / Specular',
  fluid: '💧 Fluid',
  iridescence: '🌈 Iridescence',
  prism: '🔮 Prism',
  foliage: '🌿 Foliage & Vegetation',
  bush: '🌳 Bush',
  tree: '🌲 Tree',
  water: '💧 Water',
  filter: '🖊️ Ink & Line AO',
  'fire-sparks': '🔥 Fire',
  'ash-disturbance': '🌋 Ash Disturbance',
  dust: '✨ Dust Motes',
  'water-splashes': '💦 Water Splashes',
  'underwater-bubbles': '🫧 Underwater Bubbles',
  'smelly-flies': '🪰 Smelly Flies',
  'candle-flames': '🕯️ Candle Flames',
  colorCorrection: '📷 Camera Grade',
  lens: '🔭 Lens',
  'stylized-post': '🎭 Stylized Post-Processing',
  sharpen: '🔪 Sharpen',
  dotScreen: '⚫ Dot Screen',
  halftone: '📰 Halftone',
  ascii: '💻 ASCII Art',
  dazzleOverlay: '✨ Dazzle Overlay',
  invert: '🔄 Color Invert',
  sepia: '📜 Sepia Tone',
  'ash-weather': '🌋 Ash (Weather)',
});

/** @type {Readonly<Record<string, string>>} */
export const PANEL_SECTION_TITLES = Object.freeze({
  'quick-actions': '⚡ Quick Actions',
  'panel-appearance': '🎨 Panel Appearance',
  intros: '🎬 Intros',
  'getting-started': '🚀 Getting Started',
  'support-links': '💬 Support & Links',
  'tokens-character': '🧍 Tokens & Character Rendering',
  'token-color-correction': '🎨 Color Correction',
  'sun-shadows': '☀️ Sun & Shadows',
  'dice-so-nice': '🎲 Dice So Nice',
  'sequencer-jb2a': '✨ Sequencer / JB2A',
  'rope-chain': '⛓️ Rope & Chain',
  'debug-ui': '🖥️ UI',
  'debug-settings': '⚙️ Settings',
  'debug-scene': '🗺️ Scene',
  'debug-calibration': '📐 Calibration',
  'mask-registry': '🎭 Mask Registry',
  'mask-overlay': '👁️ Mask overlay (V2)',
  'indoors-outdoors': '🏠 Indoors vs Outdoors (effective mask)',
  'vram-budget': '💾 VRAM Budget',
});

/**
 * @param {string} effectId
 * @param {string} [fallbackName]
 * @returns {string}
 */
export function getEffectDisplayTitle(effectId, fallbackName = '') {
  const id = String(effectId ?? '').trim();
  if (id && EFFECT_DISPLAY_TITLES[id]) return EFFECT_DISPLAY_TITLES[id];
  return fallbackName || id;
}

/**
 * @param {string} sectionId
 * @param {string} [fallback]
 * @returns {string}
 */
export function getPanelSectionTitle(sectionId, fallback = '') {
  const id = String(sectionId ?? '').trim();
  if (id && PANEL_SECTION_TITLES[id]) return PANEL_SECTION_TITLES[id];
  return fallback || id;
}
