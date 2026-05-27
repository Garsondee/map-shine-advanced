/**
 * Classify numeric controls by normalized position within schema min/max.
 */

import { lookupSpec } from './schema-registry.mjs';

const EPS = 1e-6;

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {number} [step]
 */
export function classifyNumericEdge(value, min, max, step) {
  const span = max - min;
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || span <= 0) {
    return { bounded: false, normalized: null, bands: {} };
  }
  const norm = (value - min) / span;
  const tol = Math.max(step ?? 0, EPS);
  const atMin = value <= min + tol;
  const atMax = value >= max - tol;
  const bands = {
    nearMin10: norm <= 0.1,
    nearMax10: norm >= 0.9,
    nearMin25: norm <= 0.25,
    nearMax25: norm >= 0.75,
    atMin,
    atMax,
  };
  return { bounded: true, normalized: norm, bands, min, max, span };
}

/**
 * @param {Map<string, import('./schema-registry.mjs').ParamSpec>} registry
 * @param {Map<string, { value: unknown, kind: string }>} flat
 */
export function classifyPresetValues(registry, flat) {
  const entries = [];
  const byEffect = new Map();
  const schemaGaps = { unbounded: [], outOfRange: [], orphan: [] };

  for (const [path, { value, kind }] of flat) {
    if (kind !== 'number' || !Number.isFinite(value)) continue;

    const spec = lookupSpec(registry, path);
    if (!spec) {
      schemaGaps.orphan.push({ path, value });
      continue;
    }

    const min = spec.min;
    const max = spec.max;
    if (min === undefined || max === undefined) {
      schemaGaps.unbounded.push({ path, value, label: spec.label });
      continue;
    }

    if (value < min - EPS || value > max + EPS) {
      schemaGaps.outOfRange.push({ path, value, min, max });
    }

    const edge = classifyNumericEdge(value, min, max, spec.step);
    const effectId = spec.effectId ?? path.split('.')[1] ?? 'unknown';
    const entry = {
      path,
      effectId,
      paramId: spec.paramId,
      value,
      label: spec.label,
      ...edge,
    };
    entries.push(entry);

    if (!byEffect.has(effectId)) {
      byEffect.set(effectId, {
        effectId,
        total: 0,
        bounded: 0,
        nearMin10: 0,
        nearMax10: 0,
        nearMin25: 0,
        nearMax25: 0,
        atMin: 0,
        atMax: 0,
      });
    }
    const agg = byEffect.get(effectId);
    agg.total++;
    if (edge.bounded) {
      agg.bounded++;
      if (edge.bands.nearMin10) agg.nearMin10++;
      if (edge.bands.nearMax10) agg.nearMax10++;
      if (edge.bands.nearMin25) agg.nearMin25++;
      if (edge.bands.nearMax25) agg.nearMax25++;
      if (edge.bands.atMin) agg.atMin++;
      if (edge.bands.atMax) agg.atMax++;
    }
  }

  const totals = {
    numeric: entries.length,
    bounded: entries.filter((e) => e.bounded).length,
    nearMin10: entries.filter((e) => e.bands?.nearMin10).length,
    nearMax10: entries.filter((e) => e.bands?.nearMax10).length,
    nearMin25: entries.filter((e) => e.bands?.nearMin25).length,
    nearMax25: entries.filter((e) => e.bands?.nearMax25).length,
    atMin: entries.filter((e) => e.bands?.atMin).length,
    atMax: entries.filter((e) => e.bands?.atMax).length,
  };

  return { entries, byEffect: [...byEffect.values()], totals, schemaGaps };
}
