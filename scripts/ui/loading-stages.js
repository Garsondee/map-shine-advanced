/**
 * Shared loading-overlay stage definitions and message formatters.
 * Keep user-facing copy honest: describe the current phase, not individual assets or effects.
 *
 * @module ui/loading-stages
 */

/** @typedef {{ id: string, label: string, weight: number }} LoadingProgressStage */

/** @type {LoadingProgressStage[]} */
export const LOADING_PROGRESS_STAGES = [
  { id: 'scene.settings',    label: 'Applying scene settings…',   weight: 4 },
  { id: 'scene.canvas',      label: 'Creating canvas…',           weight: 4 },
  { id: 'scene.renderer',    label: 'Starting renderer…',         weight: 4 },
  { id: 'assets.load',       label: 'Loading map textures…',      weight: 24 },
  { id: 'assets.gpu',        label: 'Uploading to GPU…',          weight: 8 },
  { id: 'effects.bootstrap', label: 'Starting weather…',            weight: 4 },
  { id: 'effects.core',      label: 'Building effects…',          weight: 24 },
  { id: 'scene.tokens',      label: 'Setting up tokens…',         weight: 6 },
  { id: 'scene.layers',      label: 'Organizing floors…',           weight: 6 },
  { id: 'scene.movement',    label: 'Setting up movement…',         weight: 5 },
  { id: 'scene.interaction', label: 'Building interactions…',     weight: 6 },
  { id: 'scene.camera',      label: 'Setting up camera…',           weight: 4 },
  { id: 'scene.sync',        label: 'Syncing scene…',               weight: 4 },
  { id: 'ui.bootstrap',      label: 'Starting UI…',                 weight: 5 },
  { id: 'scene.prepare',     label: 'Preparing scene…',             weight: 10 },
  { id: 'ui.panels',         label: 'Building control panels…',     weight: 6 },
  { id: 'shaders.compile',   label: 'Compiling shaders…',           weight: 14 },
  { id: 'final.controls',    label: 'Building controls…',           weight: 3 },
  { id: 'final',             label: 'Ready',                        weight: 2 },
];

/**
 * @param {number} current
 * @param {number} total
 * @returns {string}
 */
export function formatTextureLoadMessage(current, total) {
  const cur = Math.max(0, Math.floor(Number(current) || 0));
  const tot = Math.max(1, Math.floor(Number(total) || 0));
  return `Loading map textures (${cur}/${tot})…`;
}

/**
 * @param {number} uploaded
 * @param {number} total
 * @returns {string}
 */
export function formatGpuUploadMessage(uploaded, total) {
  const cur = Math.max(0, Math.floor(Number(uploaded) || 0));
  const tot = Math.max(1, Math.floor(Number(total) || 0));
  return `Uploading to GPU (${cur}/${tot})…`;
}

/**
 * @param {number} index
 * @param {number} total
 * @returns {string}
 */
export function formatEffectsInitMessage(index, total) {
  const cur = Math.max(0, Math.floor(Number(index) || 0));
  const tot = Math.max(1, Math.floor(Number(total) || 0));
  return `Building effects (${cur}/${tot})…`;
}

/**
 * Normalize shader warmup labels (`Shaders: 12/45`) to user-facing copy.
 * @param {string} label
 * @returns {string}
 */
export function formatShaderCompileMessage(label) {
  const raw = String(label || '').trim();
  const match = raw.match(/^Shaders:\s*(\d+)\s*\/\s*(\d+)/i);
  if (match) {
    return `Compiling shaders (${match[1]}/${match[2]})…`;
  }
  if (/lazy/i.test(raw)) return 'Compiling shaders (background)…';
  if (/timeout/i.test(raw)) return 'Compiling shaders (finishing up)…';
  if (!raw) return 'Compiling shaders…';
  return raw.endsWith('…') ? raw : `${raw}…`;
}
