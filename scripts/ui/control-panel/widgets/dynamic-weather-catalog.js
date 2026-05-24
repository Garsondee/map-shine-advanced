/**
 * @fileoverview Biome metadata, categories, and scene-mood presets for Dynamic Weather.
 * @module ui/control-panel/widgets/dynamic-weather-catalog
 */

/** Precipitation becomes snow above this freeze level (see WeatherController). */
export const FREEZE_SNOW_THRESHOLD = 0.55;

/** Warm presets — freeze pinned at zero so rain never becomes snow. */
export const WARM_FREEZE_BOUNDS = Object.freeze({ freezeLevelMin: 0, freezeLevelMax: 0 });

/** Cold / snow-capable presets. */
export const COLD_FREEZE_BOUNDS = Object.freeze({ freezeLevelMin: 0.6, freezeLevelMax: 1 });

/** @typedef {{ id: string, label: string, icon: string, blurb: string, traits: string[] }} BiomeInfo */

/** @typedef {{ id: string, label: string, icon: string, blurb: string, biome: string, speed: number, planMinutes: number, boundsEnabled?: boolean, bounds?: Record<string, number> }} MoodPreset */

/** @type {Record<string, { label: string, icon: string }>} */
export const DYNAMIC_BIOME_CATEGORIES = Object.freeze({
  temperate: { label: 'Temperate & Mild', icon: '🌾' },
  arid: { label: 'Arid & Dry', icon: '🏜' },
  tropical: { label: 'Tropical & Wet', icon: '🌴' },
  polar: { label: 'Cold & Alpine', icon: '🏔' },
  extreme: { label: 'Extreme & Dramatic', icon: '⛈' },
});

/** @type {Record<string, BiomeInfo & { category: string }>} */
export const DYNAMIC_BIOME_CATALOG = Object.freeze({
  'Temperate Plains': {
    id: 'Temperate Plains',
    category: 'temperate',
    label: 'Temperate Plains',
    icon: '🌾',
    blurb: 'Rolling grassland with moderate seasons — the default live-play palette.',
    traits: ['Mild storms', 'Shifting breeze', 'Balanced humidity'],
  },
  'Coastal Breeze': {
    id: 'Coastal Breeze',
    category: 'temperate',
    label: 'Coastal Breeze',
    icon: '🌊',
    blurb: 'Salt air, onshore gusts, and quick marine layer fog banks.',
    traits: ['Steady wind', 'Marine fog', 'Light drizzle'],
  },
  'Misty Vale': {
    id: 'Misty Vale',
    category: 'temperate',
    label: 'Misty Vale',
    icon: '🌫',
    blurb: 'Low sun, lingering fog, and damp air that rarely fully clears.',
    traits: ['Heavy fog', 'Soft rain', 'Muted wind'],
  },
  'Urban Heat Island': {
    id: 'Urban Heat Island',
    category: 'temperate',
    label: 'Urban Heat Island',
    icon: '🏙',
    blurb: 'Warm pavement, hazy sky, and smothered overnight cooling.',
    traits: ['Warm bias', 'Haze', 'Low storm chance'],
  },
  Desert: {
    id: 'Desert',
    category: 'arid',
    label: 'Desert',
    icon: '🏜',
    blurb: 'Hot days, cold nights, and dust on the horizon.',
    traits: ['Dry heat', 'Dust winds', 'Rare storms'],
  },
  'Steppe Winds': {
    id: 'Steppe Winds',
    category: 'arid',
    label: 'Steppe Winds',
    icon: '🌬',
    blurb: 'Open grass-steppe with persistent wind and dry squalls.',
    traits: ['Strong wind', 'Dry air', 'Fast shifts'],
  },
  'Volcanic Wastes': {
    id: 'Volcanic Wastes',
    category: 'arid',
    label: 'Volcanic Wastes',
    icon: '🌋',
    blurb: 'Ash-laden air, oppressive heat, and unstable sky.',
    traits: ['Ash haze', 'Hot baseline', 'Erratic wind'],
  },
  'Tropical Jungle': {
    id: 'Tropical Jungle',
    category: 'tropical',
    label: 'Tropical Jungle',
    icon: '🌴',
    blurb: 'Humid canopy air with frequent showers and steamy breaks.',
    traits: ['High humidity', 'Warm rain', 'Variable wind'],
  },
  'Monsoon Season': {
    id: 'Monsoon Season',
    category: 'tropical',
    label: 'Monsoon Season',
    icon: '🌧',
    blurb: 'Heavy rain cycles, saturated air, and dramatic storm fronts.',
    traits: ['Heavy rain', 'Thick clouds', 'Gust fronts'],
  },
  'Swamp & Marsh': {
    id: 'Swamp & Marsh',
    category: 'tropical',
    label: 'Swamp & Marsh',
    icon: '🐸',
    blurb: 'Still mornings, creeping fog, and slow sultry afternoons.',
    traits: ['Ground fog', 'Light rain', 'Low wind'],
  },
  Tundra: {
    id: 'Tundra',
    category: 'polar',
    label: 'Tundra',
    icon: '❄',
    blurb: 'Cold open ground with biting wind and sparse precipitation.',
    traits: ['Cold bias', 'Strong wind', 'Snow mix'],
  },
  'Arctic Blizzard': {
    id: 'Arctic Blizzard',
    category: 'polar',
    label: 'Arctic Blizzard',
    icon: '🌨',
    blurb: 'Whiteout potential — heavy snow drive and fierce gusts.',
    traits: ['Blizzard', 'Freezing', 'Violent wind'],
  },
  'Permafrost Night': {
    id: 'Permafrost Night',
    category: 'polar',
    label: 'Permafrost Night',
    icon: '🌑',
    blurb: 'Deep cold, crystal-clear air, and slow atmospheric drift.',
    traits: ['Extreme cold', 'Clear sky', 'Light wind'],
  },
  'Highland Peaks': {
    id: 'Highland Peaks',
    category: 'polar',
    label: 'Highland Peaks',
    icon: '⛰',
    blurb: 'Thin air, sharp temperature swings, and ridge-line gusts.',
    traits: ['Cold snaps', 'Fast clouds', 'Alpine wind'],
  },
  'Thunderhead Ridge': {
    id: 'Thunderhead Ridge',
    category: 'extreme',
    label: 'Thunderhead Ridge',
    icon: '⛈',
    blurb: 'Towering storm build-up with volatile wind and lightning potential.',
    traits: ['Storm spikes', 'Heavy clouds', 'Gusty'],
  },
});

/** @type {ReadonlyArray<MoodPreset>} */
export const DYNAMIC_MOOD_PRESETS = Object.freeze([
  {
    id: 'gentle-day',
    label: 'Gentle Day',
    icon: '🌤',
    biome: 'Temperate Plains',
    speed: 8,
    planMinutes: 12,
    boundsEnabled: true,
    bounds: {
      precipitationMin: 0, precipitationMax: 0.35,
      cloudCoverMin: 0.08, cloudCoverMax: 0.5,
      windSpeedMin: 0.02, windSpeedMax: 0.45,
      fogDensityMin: 0, fogDensityMax: 0.35,
      ...WARM_FREEZE_BOUNDS,
    },
    blurb: 'Soft clouds and light breeze — low drama for long sessions.',
  },
  {
    id: 'coastal-mist',
    label: 'Coastal Mist',
    icon: '🌊',
    biome: 'Coastal Breeze',
    speed: 10,
    planMinutes: 8,
    boundsEnabled: true,
    bounds: {
      precipitationMin: 0, precipitationMax: 0.4,
      cloudCoverMin: 0.25, cloudCoverMax: 0.85,
      windSpeedMin: 0.12, windSpeedMax: 0.7,
      fogDensityMin: 0.15, fogDensityMax: 0.75,
      ...WARM_FREEZE_BOUNDS,
    },
    blurb: 'Marine layer fog with onshore wind — moody but playable.',
  },
  {
    id: 'jungle-downpour',
    label: 'Jungle Downpour',
    icon: '🌧',
    biome: 'Monsoon Season',
    speed: 22,
    planMinutes: 6,
    boundsEnabled: true,
    bounds: {
      precipitationMin: 0.35, precipitationMax: 1,
      cloudCoverMin: 0.55, cloudCoverMax: 1,
      windSpeedMin: 0.08, windSpeedMax: 0.75,
      fogDensityMin: 0.05, fogDensityMax: 0.55,
      ...WARM_FREEZE_BOUNDS,
    },
    blurb: 'Wet, humid, and restless — frequent rain bursts.',
  },
  {
    id: 'blizzard-run',
    label: 'Blizzard Run',
    icon: '🌨',
    biome: 'Arctic Blizzard',
    speed: 28,
    planMinutes: 5,
    boundsEnabled: true,
    bounds: {
      precipitationMin: 0.35, precipitationMax: 1,
      cloudCoverMin: 0.45, cloudCoverMax: 1,
      windSpeedMin: 0.35, windSpeedMax: 1,
      fogDensityMin: 0.1, fogDensityMax: 0.65,
      ...COLD_FREEZE_BOUNDS,
    },
    blurb: 'Snow-heavy whiteout energy with fierce gusts.',
  },
  {
    id: 'desert-heat',
    label: 'Desert Heat',
    icon: '☀',
    biome: 'Desert',
    speed: 12,
    planMinutes: 15,
    boundsEnabled: true,
    bounds: {
      precipitationMin: 0, precipitationMax: 0.15,
      cloudCoverMin: 0, cloudCoverMax: 0.3,
      windSpeedMin: 0.05, windSpeedMax: 0.65,
      fogDensityMin: 0, fogDensityMax: 0.12,
      ...WARM_FREEZE_BOUNDS,
    },
    blurb: 'Dry, hot, and dusty — rare storms only.',
  },
  {
    id: 'volcanic-ash',
    label: 'Volcanic Ash',
    icon: '🌋',
    biome: 'Volcanic Wastes',
    speed: 18,
    planMinutes: 7,
    boundsEnabled: true,
    bounds: {
      precipitationMin: 0, precipitationMax: 0.2,
      cloudCoverMin: 0.35, cloudCoverMax: 0.9,
      windSpeedMin: 0.1, windSpeedMax: 0.85,
      fogDensityMin: 0.2, fogDensityMax: 0.85,
      ...WARM_FREEZE_BOUNDS,
      ashIntensityMin: 0.5, ashIntensityMax: 0.95,
      lightningMin: 0, lightningMax: 0.35,
      gustinessMin: 1, gustinessMax: 3,
    },
    blurb: 'Ash-thick air and oppressive heat — apocalyptic tone.',
  },
  {
    id: 'storm-chase',
    label: 'Storm Chase',
    icon: '⛈',
    biome: 'Thunderhead Ridge',
    speed: 35,
    planMinutes: 4,
    boundsEnabled: true,
    bounds: {
      precipitationMin: 0.2, precipitationMax: 1,
      cloudCoverMin: 0.4, cloudCoverMax: 1,
      windSpeedMin: 0.15, windSpeedMax: 1,
      fogDensityMin: 0, fogDensityMax: 0.45,
      ...WARM_FREEZE_BOUNDS,
      lightningMin: 0.55, lightningMax: 1,
      ashIntensityMin: 0, ashIntensityMax: 0.12,
      gustinessMin: 2, gustinessMax: 4,
    },
    blurb: 'Fast-evolving storm drama — good for set-piece scenes.',
  },
  {
    id: 'swamp-still',
    label: 'Swamp Still',
    icon: '🐸',
    biome: 'Swamp & Marsh',
    speed: 5,
    planMinutes: 18,
    boundsEnabled: true,
    bounds: {
      precipitationMin: 0.05, precipitationMax: 0.55,
      cloudCoverMin: 0.35, cloudCoverMax: 0.9,
      windSpeedMin: 0, windSpeedMax: 0.35,
      fogDensityMin: 0.25, fogDensityMax: 0.9,
      ...WARM_FREEZE_BOUNDS,
    },
    blurb: 'Slow, foggy, and oppressive — horror-friendly baseline.',
  },
]);

/**
 * @param {string} categoryId
 * @returns {Array<BiomeInfo & { category: string }>}
 */
export function biomesForCategory(categoryId) {
  return Object.values(DYNAMIC_BIOME_CATALOG).filter((b) => b.category === categoryId);
}

/**
 * @param {string} biomeId
 * @returns {(BiomeInfo & { category: string })|null}
 */
export function lookupBiome(biomeId) {
  return DYNAMIC_BIOME_CATALOG[biomeId] || null;
}

/**
 * @param {string} biomeId
 * @returns {string}
 */
export function defaultCategoryForBiome(biomeId) {
  return DYNAMIC_BIOME_CATALOG[biomeId]?.category || 'temperate';
}

/**
 * Build select options map for a category.
 * @param {string} categoryId
 * @returns {Record<string, string>}
 */
export function biomeOptionsForCategory(categoryId) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const b of biomesForCategory(categoryId)) {
    out[b.label] = b.id;
  }
  return out;
}

/**
 * All biome ids known to the catalog (may exceed WC until synced).
 * @returns {string[]}
 */
export function allCatalogBiomeIds() {
  return Object.keys(DYNAMIC_BIOME_CATALOG);
}

/** Channels off unless a mood preset or biome template explicitly enables them. */
const NEUTRAL_CHANNEL_BOUNDS = Object.freeze({
  lightningMin: 0,
  lightningMax: 0,
  ashIntensityMin: 0,
  ashIntensityMax: 0,
  gustinessMin: 0,
  gustinessMax: 3,
});

/** @type {Record<string, Record<string, number>>} */
const CATEGORY_CHANNEL_BOUNDS = Object.freeze({
  temperate: {
    lightningMin: 0, lightningMax: 0.4,
    ashIntensityMin: 0, ashIntensityMax: 0.15,
    gustinessMin: 0, gustinessMax: 3,
  },
  arid: {
    lightningMin: 0, lightningMax: 0.35,
    ashIntensityMin: 0, ashIntensityMax: 0.55,
    gustinessMin: 1, gustinessMax: 4,
  },
  tropical: {
    lightningMin: 0.1, lightningMax: 0.65,
    ashIntensityMin: 0, ashIntensityMax: 0.2,
    gustinessMin: 1, gustinessMax: 3,
  },
  polar: {
    lightningMin: 0, lightningMax: 0.25,
    ashIntensityMin: 0, ashIntensityMax: 0.08,
    gustinessMin: 1, gustinessMax: 4,
  },
  extreme: {
    lightningMin: 0.35, lightningMax: 1,
    ashIntensityMin: 0, ashIntensityMax: 0.25,
    gustinessMin: 2, gustinessMax: 4,
  },
});

/** @type {Record<string, Partial<Record<string, number>>>} */
const BIOME_CHANNEL_BOUNDS = Object.freeze({
  'Volcanic Wastes': {
    ashIntensityMin: 0.45, ashIntensityMax: 1,
    lightningMin: 0.05, lightningMax: 0.45,
  },
  'Thunderhead Ridge': {
    lightningMin: 0.55, lightningMax: 1,
    gustinessMin: 2, gustinessMax: 4,
  },
  'Arctic Blizzard': {
    ashIntensityMin: 0, ashIntensityMax: 0.05,
    lightningMin: 0, lightningMax: 0.15,
  },
  'Misty Vale': {
    lightningMin: 0, lightningMax: 0.2,
    gustinessMin: 0, gustinessMax: 2,
  },
});

/**
 * Merge scalar weather bounds with lightning, ash, and gustiness channels.
 * @param {Record<string, number>} scalarBounds
 * @param {string} biomeId
 * @param {Record<string, number>} [overrides]
 * @param {{ enrichChannels?: boolean }} [opts] When false (scene moods), lightning/ash default to off.
 * @returns {Record<string, number>}
 */
export function buildFullDynamicBounds(scalarBounds, biomeId, overrides, opts = {}) {
  const enrichChannels = opts.enrichChannels === true;

  if (!enrichChannels) {
    return {
      ...NEUTRAL_CHANNEL_BOUNDS,
      ...scalarBounds,
      ...(overrides || {}),
    };
  }

  const meta = lookupBiome(biomeId);
  const cat = meta?.category || 'temperate';
  return {
    ...(CATEGORY_CHANNEL_BOUNDS[cat] || CATEGORY_CHANNEL_BOUNDS.temperate),
    ...scalarBounds,
    ...(BIOME_CHANNEL_BOUNDS[biomeId] || {}),
    ...(overrides || {}),
  };
}

/** @type {Record<string, Record<string, number>>} */
const CATEGORY_BOUNDS_TEMPLATES = Object.freeze({
  temperate: {
    precipitationMin: 0, precipitationMax: 0.55,
    cloudCoverMin: 0.05, cloudCoverMax: 0.65,
    windSpeedMin: 0.02, windSpeedMax: 0.55,
    fogDensityMin: 0, fogDensityMax: 0.4,
    ...WARM_FREEZE_BOUNDS,
  },
  arid: {
    precipitationMin: 0, precipitationMax: 0.22,
    cloudCoverMin: 0, cloudCoverMax: 0.35,
    windSpeedMin: 0.05, windSpeedMax: 0.8,
    fogDensityMin: 0, fogDensityMax: 0.12,
    ...WARM_FREEZE_BOUNDS,
  },
  tropical: {
    precipitationMin: 0.1, precipitationMax: 0.95,
    cloudCoverMin: 0.25, cloudCoverMax: 1,
    windSpeedMin: 0.04, windSpeedMax: 0.75,
    fogDensityMin: 0.02, fogDensityMax: 0.55,
    ...WARM_FREEZE_BOUNDS,
  },
  polar: {
    precipitationMin: 0.05, precipitationMax: 0.85,
    cloudCoverMin: 0.2, cloudCoverMax: 1,
    windSpeedMin: 0.1, windSpeedMax: 1,
    fogDensityMin: 0.05, fogDensityMax: 0.55,
    ...COLD_FREEZE_BOUNDS,
  },
  extreme: {
    precipitationMin: 0.15, precipitationMax: 1,
    cloudCoverMin: 0.35, cloudCoverMax: 1,
    windSpeedMin: 0.12, windSpeedMax: 1,
    fogDensityMin: 0, fogDensityMax: 0.5,
    ...WARM_FREEZE_BOUNDS,
  },
});

/**
 * @param {string} biomeId
 * @returns {Record<string, number>}
 */
/** Biomes that should never drift into snow (non-polar play spaces). */
const WARM_BIOME_IDS = Object.freeze(new Set([
  'Temperate Plains',
  'Coastal Breeze',
  'Misty Vale',
  'Urban Heat Island',
  'Desert',
  'Steppe Winds',
  'Volcanic Wastes',
  'Tropical Jungle',
  'Monsoon Season',
  'Swamp & Marsh',
  'Thunderhead Ridge',
]));

export function deriveBiomeBounds(biomeId) {
  const meta = lookupBiome(biomeId);
  const base = { ...(CATEGORY_BOUNDS_TEMPLATES[meta?.category || 'temperate'] || CATEGORY_BOUNDS_TEMPLATES.temperate) };
  if (biomeId === 'Misty Vale' || biomeId === 'Swamp & Marsh') {
    base.fogDensityMin = 0.2;
    base.fogDensityMax = 0.9;
  }
  if (biomeId === 'Arctic Blizzard' || biomeId === 'Permafrost Night') {
    base.freezeLevelMin = 0.7;
    base.freezeLevelMax = 1;
  } else if (biomeId === 'Highland Peaks') {
    base.freezeLevelMin = 0.35;
    base.freezeLevelMax = 0.85;
  } else if (WARM_BIOME_IDS.has(biomeId)) {
    base.freezeLevelMin = 0;
    base.freezeLevelMax = 0;
  }
  if (biomeId === 'Coastal Breeze') {
    base.windSpeedMin = 0.12;
    base.windSpeedMax = 0.75;
    base.fogDensityMax = 0.65;
  }
  return buildFullDynamicBounds(base, biomeId, undefined, { enrichChannels: true });
}

/**
 * @typedef {Object} EnvironmentPresetItem
 * @property {string} id
 * @property {string} label
 * @property {string} icon
 * @property {string} blurb
 * @property {string} biome
 * @property {number} speed
 * @property {number} planMinutes
 * @property {Record<string, number>} bounds
 */

/**
 * @returns {Array<{ title: string, items: EnvironmentPresetItem[] }>}
 */
export function buildEnvironmentPresetSections() {
  /** @type {Array<{ title: string, items: EnvironmentPresetItem[] }>} */
  const sections = [{
    title: 'Scene Moods',
    items: DYNAMIC_MOOD_PRESETS.map((m) => ({
      id: `mood:${m.id}`,
      label: m.label,
      icon: m.icon,
      blurb: m.blurb,
      biome: m.biome,
      speed: m.speed,
      planMinutes: m.planMinutes,
      bounds: buildFullDynamicBounds(m.bounds, m.biome, undefined, { enrichChannels: false }),
    })),
  }];

  for (const [catId, cat] of Object.entries(DYNAMIC_BIOME_CATEGORIES)) {
    sections.push({
      title: `${cat.icon} ${cat.label}`,
      items: biomesForCategory(catId).map((b) => ({
        id: `biome:${b.id}`,
        label: b.label,
        icon: b.icon,
        blurb: b.blurb,
        biome: b.id,
        speed: 15,
        planMinutes: 6,
        bounds: deriveBiomeBounds(b.id),
      })),
    });
  }
  return sections;
}

/**
 * @param {string} presetId
 * @param {Array<{ title: string, items: EnvironmentPresetItem[] }>} sections
 * @returns {EnvironmentPresetItem|null}
 */
export function findEnvironmentPreset(presetId, sections) {
  for (const sec of sections) {
    const hit = sec.items.find((i) => i.id === presetId);
    if (hit) return hit;
  }
  return null;
}
