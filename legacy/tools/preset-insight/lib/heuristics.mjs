/**
 * Cross-preset pattern detection and ranked findings.
 */

import { tagLightDark } from './light-dark-balance.mjs';

/**
 * @param {Array<{ id: string, classified: ReturnType<import('./edge-classifier.mjs').classifyPresetValues> }>} presets
 * @param {Map<string, import('./schema-registry.mjs').ParamSpec>} registry
 */
export function runHeuristics(presets, registry) {
  /** @type {Array<{ severity: 'high'|'medium'|'low', code: string, message: string, paths?: string[] }>} */
  const findings = [];

  const pathValues = new Map();
  for (const { id, classified } of presets) {
    for (const e of classified.entries) {
      if (!pathValues.has(e.path)) pathValues.set(e.path, []);
      pathValues.get(e.path).push({ presetId: id, value: e.value, normalized: e.normalized, bands: e.bands });
    }
  }

  for (const [p, rows] of pathValues) {
    if (rows.length < presets.length) continue;
    const allAtMin = rows.every((r) => r.bands?.atMin);
    const allAtMax = rows.every((r) => r.bands?.atMax);
    if (allAtMin || allAtMax) {
      findings.push({
        severity: 'medium',
        code: 'unanimous_edge',
        message: `All ${presets.length} presets pin ${p} at ${allAtMin ? 'minimum' : 'maximum'} — range or default may be wrong, or effect gain needs rescaling.`,
        paths: [p],
      });
    }
  }

  for (const { id, classified } of presets) {
    for (const agg of classified.byEffect) {
      if (agg.bounded < 4) continue;
      const topPct = agg.nearMax25 / agg.bounded;
      const botPct = agg.nearMin25 / agg.bounded;
      if (topPct > 0.5 || botPct > 0.5) {
        findings.push({
          severity: 'high',
          code: 'effect_cluster_edge',
          message: `Preset "${id}": effect "${agg.effectId}" has ${Math.round(Math.max(topPct, botPct) * 100)}% of bounded params in an outer 25% band — possible scale/inversion issue.`,
          paths: [`effects.${agg.effectId}.*`],
        });
      }
    }

    if (classified.schemaGaps.outOfRange.length) {
      findings.push({
        severity: 'medium',
        code: 'out_of_schema_range',
        message: `Preset "${id}": ${classified.schemaGaps.outOfRange.length} value(s) outside schema min/max (stale export or schema drift).`,
        paths: classified.schemaGaps.outOfRange.map((x) => x.path).slice(0, 8),
      });
    }

    if (classified.schemaGaps.orphan.length > 20) {
      findings.push({
        severity: 'low',
        code: 'orphan_keys',
        message: `Preset "${id}": ${classified.schemaGaps.orphan.length} numeric keys without registry entry (legacy or unregistered effect params).`,
      });
    }

    const lightEntries = classified.entries.filter(
      (e) => e.bounded && tagLightDark(e.path) === 'light' && e.bands?.nearMax25,
    );
    const darkEntries = classified.entries.filter(
      (e) => e.bounded && tagLightDark(e.path) === 'dark' && e.bands?.nearMax25,
    );
    if (lightEntries.length >= 5 && darkEntries.length >= 5) {
      findings.push({
        severity: 'high',
        code: 'fighting_forces',
        message: `Preset "${id}": many light- and dark-tagged controls pushed toward max — lighting systems may be fighting each other.`,
      });
    }
  }

  let neverVariesCount = 0;
  const NEVER_VARIES_CAP = 20;
  for (const [path, rows] of pathValues) {
    if (!path.startsWith('effects.') || rows.length < presets.length) continue;
    if (neverVariesCount >= NEVER_VARIES_CAP) break;
    const spec = registry.get(path);
    if (!spec || spec.default === undefined) continue;
    const vals = new Set(rows.map((r) => r.value));
    if (vals.size !== 1) continue;
    const only = [...vals][0];
    if (only === spec.default) {
      neverVariesCount++;
      findings.push({
        severity: 'low',
        code: 'never_varies',
        message: `${path} is identical default (${only}) across all compared presets — control may be unused in practice.`,
        paths: [path],
      });
    }
  }

  const severityOrder = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return findings;
}
