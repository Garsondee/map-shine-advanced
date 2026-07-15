/**
 * Diff preset flat maps vs a reference preset.
 */

import { lookupSpec } from './schema-registry.mjs';

/**
 * @param {Map<string, { value: unknown, kind: string }>} targetFlat
 * @param {Map<string, { value: unknown, kind: string }>} refFlat
 * @param {Map<string, import('./schema-registry.mjs').ParamSpec>} registry
 */
export function diffPresets(targetFlat, refFlat, registry) {
  const allPaths = new Set([...targetFlat.keys(), ...refFlat.keys()]);
  const changes = [];
  const enabledToggles = [];

  for (const path of allPaths) {
    const t = targetFlat.get(path);
    const r = refFlat.get(path);
    const tv = t?.value;
    const rv = r?.value;
    if (Object.is(tv, rv)) continue;
    if (tv === undefined || rv === undefined) continue;

    const spec = lookupSpec(registry, path);
    const effectId = path.startsWith('effects.')
      ? path.split('.')[1]
      : path.startsWith('controlState')
        ? 'controlState'
        : 'other';

    let relativeDelta = null;
    if (typeof tv === 'number' && typeof rv === 'number' && spec?.min != null && spec?.max != null) {
      const span = spec.max - spec.min;
      if (span > 0) relativeDelta = Math.abs(tv - rv) / span;
    }

    const row = {
      path,
      effectId,
      paramId: spec?.paramId ?? path.split('.').pop(),
      label: spec?.label,
      target: tv,
      reference: rv,
      relativeDelta,
      kind: typeof tv,
    };

    if (path.endsWith('.enabled') && (typeof tv === 'boolean' || typeof rv === 'boolean')) {
      enabledToggles.push(row);
    } else {
      changes.push(row);
    }
  }

  changes.sort((a, b) => (b.relativeDelta ?? 0) - (a.relativeDelta ?? 0));

  const byEffect = new Map();
  for (const c of changes) {
    if (!byEffect.has(c.effectId)) byEffect.set(c.effectId, []);
    byEffect.get(c.effectId).push(c);
  }

  return { changes, enabledToggles, byEffect: Object.fromEntries(byEffect) };
}
