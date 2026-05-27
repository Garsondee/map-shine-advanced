/**
 * Light vs Dark taxonomy and tension metrics for preset analysis.
 */

const LIGHT_EFFECTS = new Set([
  'lighting',
  'bloom',
  'player-light',
  'windowLight',
  'fire-sparks',
  'candle-flames',
  'lightning',
  'weather-lightning',
  'colorCorrection',
  'sky-color',
  'specular',
  'iridescence',
  'prism',
  'dazzleOverlay',
  'water',
  'cloud',
]);

const DARK_EFFECTS = new Set([
  'building-shadows',
  'overhead-shadows',
  'painted-shadows',
  'sky-reach-shadows',
  'fog',
  'atmospheric-fog',
  'invert',
  'filter',
  'floor-depth-blur',
  'ash-weather',
]);

const LIGHT_KEYWORDS = /\b(bright|brightness|ambient|exposure|gain|torch|emissive|flash|bloom|highlight|luminance|light(?!ning)|glow|intensity(?!scale))\b/i;
const DARK_KEYWORDS = /\b(dark|darkness|shadow|smother|occlusion|crush|density|opacity|fog|murk|shade|blackout|invert)\b/i;

/**
 * @param {string} path
 * @returns {'light'|'dark'|'neutral'|'unknown'}
 */
export function tagLightDark(path) {
  const parts = path.split('.');
  const effectId = parts[0] === 'effects' ? parts[1] : parts[0] === 'controlState' ? 'controlState' : '';
  const paramId = parts[parts.length - 1] ?? '';
  const full = `${effectId}.${paramId}`;

  if (LIGHT_EFFECTS.has(effectId)) {
    if (DARK_KEYWORDS.test(paramId) && !LIGHT_KEYWORDS.test(paramId)) return 'dark';
    return 'light';
  }
  if (DARK_EFFECTS.has(effectId)) {
    if (LIGHT_KEYWORDS.test(paramId) && !DARK_KEYWORDS.test(paramId)) return 'light';
    return 'dark';
  }
  if (LIGHT_KEYWORDS.test(full) || LIGHT_KEYWORDS.test(paramId)) return 'light';
  if (DARK_KEYWORDS.test(full) || DARK_KEYWORDS.test(paramId)) return 'dark';
  if (effectId === 'weather' && /fog|cloud|precipitation|freeze/i.test(paramId)) return 'dark';
  if (effectId === 'controlState' && /fog|precipitation|freeze|cloud/i.test(paramId)) return 'dark';
  if (effectId === 'controlState' && /timeOfDay/i.test(paramId)) return 'neutral';
  return 'unknown';
}

/**
 * @param {ReturnType<import('./edge-classifier.mjs').classifyPresetValues>['entries']} classifiedEntries
 */
export function computeLightDarkBalance(classifiedEntries) {
  const buckets = { light: [], dark: [], neutral: [], unknown: [] };
  for (const e of classifiedEntries) {
    if (!e.bounded || e.normalized == null) continue;
    const tag = tagLightDark(e.path);
    buckets[tag]?.push(e);
  }

  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x.normalized, 0) / arr.length : null);

  const lightMean = mean(buckets.light);
  const darkMean = mean(buckets.dark);
  const lightRailPct = buckets.light.length
    ? (buckets.light.filter((x) => x.bands?.nearMax25).length / buckets.light.length) * 100
    : 0;
  const darkRailPct = buckets.dark.length
    ? (buckets.dark.filter((x) => x.bands?.nearMax25).length / buckets.dark.length) * 100
    : 0;

  const tensionIndex =
    lightMean != null && darkMean != null ? lightMean - darkMean : null;
  const bothArmiesAtRails = lightRailPct >= 40 && darkRailPct >= 40;

  const narratives = [];
  if (tensionIndex != null) {
    if (tensionIndex > 0.25 && darkMean > 0.6) {
      narratives.push(
        'Light and dark controls are both pushed high — strong "fighting forces" signature; scene may clip or look muddy.',
      );
    } else if (tensionIndex > 0.2) {
      narratives.push('Light-leaning balance vs dark controls; watch for blow-out on bright maps.');
    } else if (tensionIndex < -0.2) {
      narratives.push('Dark-leaning balance; scene may read crushed unless light sources compensate.');
    } else {
      narratives.push('Light/dark means are relatively balanced in normalized space.');
    }
  }
  if (bothArmiesAtRails) {
    narratives.push(
      'Many light-tagged and dark-tagged sliders sit in the top 25% of their ranges — consider narrowing ranges or revisiting defaults.',
    );
  }

  return {
    counts: {
      light: buckets.light.length,
      dark: buckets.dark.length,
      neutral: buckets.neutral.length,
      unknown: buckets.unknown.length,
    },
    means: { light: lightMean, dark: darkMean },
    tensionIndex,
    lightRailPct,
    darkRailPct,
    bothArmiesAtRails,
    narratives,
    buckets,
  };
}

/**
 * @param {ReturnType<import('./edge-classifier.mjs').classifyPresetValues>['entries']} targetEntries
 * @param {ReturnType<import('./edge-classifier.mjs').classifyPresetValues>['entries']} refEntries
 * @param {number} [limit]
 */
export function opposingDeltasVsReference(targetEntries, refEntries, limit = 12) {
  const refMap = new Map(refEntries.map((e) => [e.path, e]));
  const deltas = [];
  for (const t of targetEntries) {
    const r = refMap.get(t.path);
    if (!r || t.normalized == null || r.normalized == null) continue;
    const delta = t.normalized - r.normalized;
    if (Math.abs(delta) < 0.05) continue;
    deltas.push({
      path: t.path,
      tag: tagLightDark(t.path),
      delta,
      targetNorm: t.normalized,
      refNorm: r.normalized,
      label: t.label,
    });
  }
  const lightUp = deltas.filter((d) => d.tag === 'light' && d.delta > 0).sort((a, b) => b.delta - a.delta);
  const darkUp = deltas.filter((d) => d.tag === 'dark' && d.delta > 0).sort((a, b) => b.delta - a.delta);
  const lightDown = deltas.filter((d) => d.tag === 'light' && d.delta < 0).sort((a, b) => a.delta - b.delta);
  const darkDown = deltas.filter((d) => d.tag === 'dark' && d.delta < 0).sort((a, b) => a.delta - b.delta);
  return {
    lightIncreased: lightUp.slice(0, limit),
    darkIncreased: darkUp.slice(0, limit),
    lightDecreased: lightDown.slice(0, limit),
    darkDecreased: darkDown.slice(0, limit),
  };
}
