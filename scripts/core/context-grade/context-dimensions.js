/**
 * @fileoverview Registry of contextual probe dimensions (extensible).
 * @module core/context-grade/context-dimensions
 */

/** @typedef {'indoorOutdoor'|'skyCondition'|'cloudShadow'|'canopy'|'interiorLight'|'coverShadow'} ContextDimensionId */

/**
 * @type {ReadonlyArray<{ id: ContextDimensionId, label: string }>}
 */
export const CONTEXT_DIMENSIONS = Object.freeze([
  { id: 'indoorOutdoor', label: 'Indoor / Outdoor' },
  { id: 'skyCondition', label: 'Sky condition' },
  { id: 'cloudShadow', label: 'Cloud shadow' },
  { id: 'canopy', label: 'Canopy / sky reach' },
  { id: 'interiorLight', label: 'Interior light' },
  { id: 'coverShadow', label: 'Cover shadow' },
]);

/**
 * @typedef {Object} ContextDimensionSnapshot
 * @property {'indoor'|'outdoor'|'unknown'} indoorOutdoor
 * @property {'clear'|'overcast'|'storm'|'unknown'} outdoorSky
 * @property {'sunlit'|'shadowed'|'unknown'} cloudShadow
 * @property {'open'|'shaded'|'unknown'} canopy
 * @property {'deep'|'windowLit'|'unknown'} interiorLight
 * @property {'sunlit'|'buildingShadow'|'paintedShadow'|'treeDapple'|'unknown'} coverShadow
 */

/** @returns {ContextDimensionSnapshot} */
export function createEmptyDimensionSnapshot() {
  return {
    indoorOutdoor: 'unknown',
    outdoorSky: 'unknown',
    cloudShadow: 'unknown',
    canopy: 'unknown',
    interiorLight: 'unknown',
    coverShadow: 'unknown',
  };
}

/**
 * @param {ContextDimensionSnapshot} dims
 * @param {import('./context-env-resolver.js').ContextEnvResolver|null} env
 * @returns {string}
 */
/**
 * Active contextual triggers — one label per line in the status panel.
 *
 * @param {ContextDimensionSnapshot} dims
 * @param {import('./context-env-resolver.js').ContextEnvResolver|null} env
 * @returns {string[]}
 */
export function formatContextKeyLines(dims, env = null) {
  const lines = [];
  if (dims.indoorOutdoor !== 'unknown') lines.push(dims.indoorOutdoor);
  if (env) {
    if (env.skyCondition && env.skyCondition !== 'unknown') lines.push(`env:${env.skyCondition}`);
    if (env.dayPhase) lines.push(`env:${env.dayPhase}`);
    if (env.darknessMood === 'heavy') lines.push('env:dark');
  }
  if (dims.indoorOutdoor === 'outdoor') {
    if (dims.outdoorSky !== 'unknown' && dims.outdoorSky !== 'clear') lines.push(dims.outdoorSky);
    if (dims.cloudShadow === 'shadowed') lines.push('cloudShadow');
    if (dims.canopy === 'shaded') lines.push('canopy');
    if (dims.coverShadow === 'buildingShadow') lines.push('buildingShadow');
    else if (dims.coverShadow === 'paintedShadow') lines.push('paintedShadow');
    else if (dims.coverShadow === 'treeDapple') lines.push('treeDapple');
  }
  if (dims.indoorOutdoor === 'indoor' && dims.interiorLight === 'windowLit') {
    lines.push('windowLit');
  }
  return lines.length ? lines : ['neutral'];
}

/**
 * @param {ContextDimensionSnapshot} dims
 * @param {import('./context-env-resolver.js').ContextEnvResolver|null} env
 * @returns {string}
 */
export function formatContextKeyMultiline(dims, env = null) {
  return formatContextKeyLines(dims, env).join('\n');
}

/**
 * @param {ContextDimensionSnapshot} dims
 * @param {import('./context-env-resolver.js').ContextEnvResolver|null} env
 * @returns {string}
 */
export function formatContextKey(dims, env = null) {
  return formatContextKeyLines(dims, env).join(' · ');
}
