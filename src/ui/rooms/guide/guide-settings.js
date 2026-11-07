/**
 * ui/rooms/guide/guide-settings.js — "every setting" tables, built LIVE from the effects'
 * own parameter schemas (mmp-0mv.7).
 *
 * A page writes `[[settings: water]]` and the room draws a folded-away table of every live
 * setting of that effect, grouped the way the Studio groups them, with the Studio's own
 * label, its help text, the default and the range. Nothing is copied into the guide, so a
 * renamed setting, a new default or a new help sentence shows up in the guide the moment it
 * ships — and a setting marked `status: 'planned'` never appears.
 *
 * @module ui/rooms/guide/guide-settings
 */

import {
  WATER_PARAMS,
  FIRE_PARAMS,
  SPECULAR_PARAMS,
  WINDOW_PARAMS,
  FLUID_PARAMS,
  VEGETATION_PARAMS,
  PRECIPITATION_PARAMS,
  PRISM_PARAMS,
  IRIDESCENCE_PARAMS,
  DUST_PARAMS,
  SUN_SHADOW_PARAMS,
  BLOOM_PARAMS,
  LENS_PARAMS,
  DYNAMIC_RANGE_PARAMS,
  GRADE_LOOK_PARAMS,
  DOF_PARAMS,
  CLOUD_LOOK_PARAMS,
  CLOUD_TOPS_PARAMS,
} from '../../../effects/index.js';
import { escapeHtml } from './guide-markdown.js';

/** Effect id (as the Studio registers it) → its Studio title and schema. */
export const GUIDE_SETTINGS = Object.freeze({
  water: { title: 'Water', params: WATER_PARAMS },
  fire: { title: 'Fire', params: FIRE_PARAMS },
  specular: { title: 'Metal & shine', params: SPECULAR_PARAMS },
  window: { title: 'Window light', params: WINDOW_PARAMS },
  fluid: { title: 'Fluid', params: FLUID_PARAMS },
  vegetation: { title: 'Vegetation (trees & bushes)', params: VEGETATION_PARAMS },
  precipitation: { title: 'Precipitation', params: PRECIPITATION_PARAMS },
  prism: { title: 'Prism', params: PRISM_PARAMS },
  iridescence: { title: 'Iridescence', params: IRIDESCENCE_PARAMS },
  dust: { title: 'Dust', params: DUST_PARAMS },
  sunShadows: { title: 'Sun shadows', params: SUN_SHADOW_PARAMS },
  bloom: { title: 'Bloom', params: BLOOM_PARAMS },
  lens: { title: 'Lens', params: LENS_PARAMS },
  dynamicRange: { title: 'Dynamic Range', params: DYNAMIC_RANGE_PARAMS },
  grade: { title: 'Colour Grade', params: GRADE_LOOK_PARAMS },
  depthOfField: { title: 'Depth of Field', params: DOF_PARAMS },
  clouds: { title: 'Clouds', params: CLOUD_LOOK_PARAMS },
  cloudTops: { title: 'Cloud Tops', params: CLOUD_TOPS_PARAMS },
});

const SHOWN_TYPES = new Set(['float', 'int', 'bool', 'enum', 'color', 'angle']);

function num(v) {
  return String(Math.round(Number(v) * 1000) / 1000);
}

/** A setting's default, as a person would read it. */
export function defaultText(decl) {
  const d = decl.default;
  if (decl.type === 'bool') return d ? 'On' : 'Off';
  if (decl.type === 'color') {
    const hex = typeof d === 'string' ? d : typeof d === 'number' ? `#${d.toString(16).padStart(6, '0')}` : '';
    return hex;
  }
  if (decl.type === 'enum') return String(d);
  if (typeof d === 'number') return num(d) + (decl.type === 'angle' ? '°' : '');
  return String(d ?? '');
}

function rangeText(decl) {
  if (decl.type === 'enum' && Array.isArray(decl.values)) {
    return decl.values.map((v) => (typeof v === 'object' ? (v.label ?? v.value) : v)).join(', ');
  }
  if (typeof decl.min === 'number' && typeof decl.max === 'number') return `${num(decl.min)} – ${num(decl.max)}`;
  return '';
}

/**
 * The live settings of one effect, in the Studio's category order.
 * @param {string} effectId
 * @returns {Array<{category: string, rows: Array<{key: string, label: string, help: string, def: string, range: string, type: string}>}>|null}
 */
export function settingsGroups(effectId) {
  const spec = GUIDE_SETTINGS[effectId];
  if (!spec) return null;
  const groups = new Map();
  for (const [key, decl] of Object.entries(spec.params)) {
    if (!decl || decl.status === 'planned' || !SHOWN_TYPES.has(decl.type)) continue;
    if (decl.scope === 'client' && /debug/i.test(`${key} ${decl.category ?? ''}`)) continue;
    const cat = decl.category ?? 'Settings';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push({
      key,
      label: decl.label ?? key,
      help: decl.help ?? '',
      def: defaultText(decl),
      range: rangeText(decl),
      type: decl.type,
    });
  }
  return [...groups].map(([category, rows]) => ({ category, rows }));
}

/** The `[[settings: id]]` block: a folded table of every setting. */
export function settingsTableHtml(effectId) {
  const spec = GUIDE_SETTINGS[effectId];
  const groups = settingsGroups(effectId);
  if (!spec || !groups) return `<p class="g-bad">No settings table for "${escapeHtml(effectId)}".</p>`;
  const count = groups.reduce((n, g) => n + g.rows.length, 0);
  const body = groups
    .map(
      (g) =>
        `<h5>${escapeHtml(g.category)}</h5><div class="g-table-wrap"><table class="g-table g-settings-table">` +
        `<thead><tr><th>Setting</th><th>What it does</th><th>Default</th><th>Range</th></tr></thead><tbody>` +
        g.rows
          .map((r) => {
            const def =
              r.type === 'color' && r.def
                ? `<span class="g-swatch" style="background:${escapeHtml(r.def)}"></span>${escapeHtml(r.def)}`
                : escapeHtml(r.def);
            return `<tr><td>${escapeHtml(r.label)}</td><td>${escapeHtml(r.help)}</td><td>${def}</td><td>${escapeHtml(r.range)}</td></tr>`;
          })
          .join('') +
        `</tbody></table></div>`
    )
    .join('');
  return (
    `<details class="g-settings"><summary><span>Every ${escapeHtml(spec.title)} setting</span>` +
    `<small>${count} settings · Studio → Effects → ${escapeHtml(spec.title)}</small></summary>${body}</details>`
  );
}
