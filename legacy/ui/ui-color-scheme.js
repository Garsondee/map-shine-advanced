/**
 * @fileoverview Tweakpane / Map Shine control panel colour schemes.
 * Applies CSS custom properties to all module Tweakpane surfaces via a runtime
 * stylesheet (`#ms-ui-theme-active`) plus `data-ms-ui-theme` on each host.
 *
 * @module ui/ui-color-scheme
 */

/** @type {string} */
export const DEFAULT_UI_COLOR_SCHEME_ID = 'charcoal';

/** @type {string} */
const RUNTIME_STYLE_ID = 'ms-ui-theme-active';

/**
 * @typedef {Object} UiColorSchemeDef
 * @property {string} id
 * @property {string} label
 * @property {boolean} accessibility
 */

/** @type {readonly UiColorSchemeDef[]} */
export const UI_COLOR_SCHEMES = Object.freeze([
  { id: 'charcoal', label: 'Charcoal', accessibility: false },
  { id: 'midnight', label: 'Midnight Blue', accessibility: false },
  { id: 'forge', label: 'Forge Amber', accessibility: false },
  { id: 'high-contrast', label: 'High Contrast', accessibility: true },
  { id: 'soft-light', label: 'Soft Light', accessibility: true },
]);

/** @type {ReadonlySet<string>} */
const SCHEME_IDS = new Set(UI_COLOR_SCHEMES.map((s) => s.id));

/** @type {readonly string[]} */
export const UI_COLOR_SCHEME_ROOT_SELECTORS = Object.freeze([
  '#map-shine-ui',
  '#map-shine-effect-stack',
  '#map-shine-texture-manager',
  '#map-shine-graphics-settings',
  '#map-shine-diagnostic-center',
  '#map-shine-tile-motion-dialog',
  '#map-shine-token-movement-dialog',
]);

/** @type {string} */
const HOST_SELECTOR_LIST = UI_COLOR_SCHEME_ROOT_SELECTORS.join(',\n');

/**
 * Full custom-property blocks per scheme (injected at runtime so dropdown changes apply immediately).
 * @type {Readonly<Record<string, string>>}
 */
const THEME_TOKEN_BLOCKS = Object.freeze({
  charcoal: `
  color-scheme: dark;
  --tp-base-background-color: #1e2329;
  --tp-base-border-radius: 6px;
  --tp-base-shadow-color: rgba(0, 0, 0, 0.45);
  --tp-base-font-family: var(--font-primary, 'Signika', sans-serif);
  --tp-button-background-color: #6b7380;
  --tp-button-background-color-hover: #7c8491;
  --tp-button-background-color-focus: #8a929f;
  --tp-button-background-color-active: #959dad;
  --tp-button-foreground-color: #14181e;
  --tp-container-background-color: rgba(255, 255, 255, 0.06);
  --tp-container-background-color-hover: rgba(255, 255, 255, 0.10);
  --tp-container-background-color-focus: rgba(255, 255, 255, 0.12);
  --tp-container-background-color-active: rgba(255, 255, 255, 0.14);
  --tp-container-foreground-color: rgba(245, 248, 255, 0.92);
  --tp-input-background-color: rgba(255, 255, 255, 0.07);
  --tp-input-background-color-hover: rgba(255, 255, 255, 0.11);
  --tp-input-background-color-focus: rgba(255, 255, 255, 0.14);
  --tp-input-background-color-active: rgba(255, 255, 255, 0.16);
  --tp-input-foreground-color: rgba(245, 248, 255, 0.95);
  --tp-label-foreground-color: rgba(245, 248, 255, 0.62);
  --tp-monitor-background-color: rgba(0, 0, 0, 0.28);
  --tp-monitor-foreground-color: rgba(245, 248, 255, 0.72);
  --tp-groove-foreground-color: rgba(255, 255, 255, 0.08);
  --ms-ui-shadow: rgba(0, 0, 0, 0.4);
  --ms-ui-text: rgba(245, 248, 255, 0.95);
  --ms-ui-text-muted: rgba(245, 248, 255, 0.88);
  --ms-ui-text-faint: rgba(245, 248, 255, 0.65);
  --ms-ui-border: rgba(255, 255, 255, 0.12);
  --ms-ui-border-strong: rgba(255, 255, 255, 0.22);
  --ms-ui-border-focus: rgba(140, 195, 255, 0.55);
  --ms-ui-surface: rgba(255, 255, 255, 0.06);
  --ms-ui-surface-hover: rgba(255, 255, 255, 0.11);
  --ms-ui-surface-active: rgba(255, 255, 255, 0.14);
  --ms-ui-input-bg: rgba(255, 255, 255, 0.07);
  --ms-ui-input-bg-hover: rgba(255, 255, 255, 0.10);
  --ms-ui-toolbar-start: #2a3038;
  --ms-ui-toolbar-end: #222730;
  --ms-ui-status-start: #2e343d;
  --ms-ui-status-end: #262b33;
  --ms-ui-scrollbar-thumb: rgba(255, 255, 255, 0.6);
  --ms-ui-scrollbar-track: rgba(0, 0, 0, 0.4);
  --ms-ui-scrollbar-thumb-hover: rgba(255, 255, 255, 0.85);
  --ms-ui-accent: rgba(255, 180, 60, 0.95);
  --ms-ui-success: #5fe08a;
  --ms-ui-success-bg: rgba(46, 166, 86, 0.16);
  --ms-ui-success-border: rgba(78, 210, 126, 0.45);
  --ms-ui-success-text: rgba(220, 255, 230, 0.98);
  --ms-ui-danger: rgba(255, 210, 210, 0.95);
  --ms-ui-danger-bg: rgba(120, 0, 0, 0.16);
  --ms-ui-danger-border: rgba(255, 120, 120, 0.38);
  --ms-ui-danger-bg-hover: rgba(140, 20, 20, 0.26);
  --ms-ui-danger-border-hover: rgba(255, 140, 140, 0.5);
  --ms-ui-off-bg: rgba(166, 62, 46, 0.14);
  --ms-ui-off-border: rgba(230, 100, 84, 0.4);
  --ms-ui-off-text: rgba(255, 220, 215, 0.96);
  --ms-ui-off-dot: #e87060;
  --ms-ui-filter-match: rgba(255, 220, 90, 0.97);
  --ms-ui-filter-match-bg: rgba(255, 200, 50, 0.13);
  --ms-ui-link-bug: #66aaff;
  --ms-ui-link-patreon: #ff424d;
  --ms-ui-link-store: #ff6400;
  --ms-ui-folder-lighting: rgba(130, 180, 255, 0.45);
  --ms-ui-folder-grade: rgba(255, 210, 125, 0.45);
  --ms-ui-select-option-bg: #1a1f28;
  --ms-ui-divider-mid: rgba(255, 255, 255, 0.08);
  --ms-ui-divider-edge: rgba(255, 255, 255, 0.02);`,

  midnight: `
  color-scheme: dark;
  --tp-base-background-color: #141c28;
  --tp-base-border-radius: 6px;
  --tp-base-shadow-color: rgba(0, 8, 24, 0.55);
  --tp-base-font-family: var(--font-primary, 'Signika', sans-serif);
  --tp-button-background-color: #3d8ec4;
  --tp-button-background-color-hover: #4a9ed4;
  --tp-button-background-color-focus: #58aae0;
  --tp-button-background-color-active: #66b6ea;
  --tp-button-foreground-color: #0a121c;
  --tp-container-background-color: rgba(120, 180, 255, 0.08);
  --tp-container-background-color-hover: rgba(120, 180, 255, 0.13);
  --tp-container-background-color-focus: rgba(120, 180, 255, 0.16);
  --tp-container-background-color-active: rgba(120, 180, 255, 0.19);
  --tp-container-foreground-color: rgba(220, 235, 255, 0.94);
  --tp-input-background-color: rgba(80, 140, 220, 0.12);
  --tp-input-background-color-hover: rgba(80, 140, 220, 0.17);
  --tp-input-background-color-focus: rgba(80, 140, 220, 0.22);
  --tp-input-background-color-active: rgba(80, 140, 220, 0.26);
  --tp-input-foreground-color: rgba(230, 242, 255, 0.96);
  --tp-label-foreground-color: rgba(180, 210, 245, 0.72);
  --tp-monitor-background-color: rgba(0, 12, 32, 0.45);
  --tp-monitor-foreground-color: rgba(190, 220, 255, 0.78);
  --tp-groove-foreground-color: rgba(100, 160, 230, 0.14);
  --ms-ui-shadow: rgba(0, 10, 30, 0.5);
  --ms-ui-text: rgba(225, 240, 255, 0.96);
  --ms-ui-text-muted: rgba(200, 220, 245, 0.9);
  --ms-ui-text-faint: rgba(160, 190, 230, 0.72);
  --ms-ui-border: rgba(100, 160, 230, 0.18);
  --ms-ui-border-strong: rgba(120, 180, 255, 0.28);
  --ms-ui-border-focus: rgba(90, 190, 255, 0.65);
  --ms-ui-surface: rgba(80, 130, 210, 0.10);
  --ms-ui-surface-hover: rgba(90, 150, 230, 0.16);
  --ms-ui-surface-active: rgba(100, 165, 240, 0.20);
  --ms-ui-input-bg: rgba(60, 110, 190, 0.14);
  --ms-ui-input-bg-hover: rgba(70, 125, 205, 0.20);
  --ms-ui-toolbar-start: #1a2838;
  --ms-ui-toolbar-end: #121e2c;
  --ms-ui-status-start: #1c2a3c;
  --ms-ui-status-end: #152030;
  --ms-ui-scrollbar-thumb: rgba(140, 190, 255, 0.55);
  --ms-ui-scrollbar-track: rgba(0, 12, 32, 0.55);
  --ms-ui-scrollbar-thumb-hover: rgba(170, 210, 255, 0.8);
  --ms-ui-accent: rgba(100, 200, 255, 0.98);
  --ms-ui-success: #6ef0a8;
  --ms-ui-success-bg: rgba(40, 140, 90, 0.22);
  --ms-ui-success-border: rgba(80, 220, 140, 0.5);
  --ms-ui-success-text: rgba(210, 255, 230, 0.98);
  --ms-ui-danger: rgba(255, 210, 210, 0.95);
  --ms-ui-danger-bg: rgba(80, 20, 40, 0.28);
  --ms-ui-danger-border: rgba(255, 120, 150, 0.45);
  --ms-ui-danger-bg-hover: rgba(140, 20, 20, 0.26);
  --ms-ui-danger-border-hover: rgba(255, 140, 140, 0.5);
  --ms-ui-off-bg: rgba(100, 40, 50, 0.22);
  --ms-ui-off-border: rgba(240, 120, 110, 0.45);
  --ms-ui-off-text: rgba(255, 220, 215, 0.96);
  --ms-ui-off-dot: #e87060;
  --ms-ui-filter-match: rgba(130, 220, 255, 0.98);
  --ms-ui-filter-match-bg: rgba(80, 180, 255, 0.18);
  --ms-ui-link-bug: #7ec8ff;
  --ms-ui-link-patreon: #ff424d;
  --ms-ui-link-store: #ff6400;
  --ms-ui-folder-lighting: rgba(90, 190, 255, 0.55);
  --ms-ui-folder-grade: rgba(255, 220, 140, 0.5);
  --ms-ui-select-option-bg: #101820;
  --ms-ui-divider-mid: rgba(100, 160, 230, 0.14);
  --ms-ui-divider-edge: rgba(60, 100, 160, 0.06);`,

  forge: `
  color-scheme: dark;
  --tp-base-background-color: #241a14;
  --tp-base-border-radius: 6px;
  --tp-base-shadow-color: rgba(20, 8, 0, 0.5);
  --tp-base-font-family: var(--font-primary, 'Signika', sans-serif);
  --tp-button-background-color: #c87838;
  --tp-button-background-color-hover: #d88848;
  --tp-button-background-color-focus: #e49858;
  --tp-button-background-color-active: #eca868;
  --tp-button-foreground-color: #1a1008;
  --tp-container-background-color: rgba(255, 180, 100, 0.08);
  --tp-container-background-color-hover: rgba(255, 180, 100, 0.13);
  --tp-container-background-color-focus: rgba(255, 180, 100, 0.16);
  --tp-container-background-color-active: rgba(255, 180, 100, 0.19);
  --tp-container-foreground-color: rgba(255, 235, 210, 0.94);
  --tp-input-background-color: rgba(255, 160, 80, 0.10);
  --tp-input-background-color-hover: rgba(255, 160, 80, 0.15);
  --tp-input-background-color-focus: rgba(255, 160, 80, 0.19);
  --tp-input-background-color-active: rgba(255, 160, 80, 0.23);
  --tp-input-foreground-color: rgba(255, 240, 220, 0.96);
  --tp-label-foreground-color: rgba(230, 190, 150, 0.75);
  --tp-monitor-background-color: rgba(20, 10, 0, 0.42);
  --tp-monitor-foreground-color: rgba(255, 210, 160, 0.78);
  --tp-groove-foreground-color: rgba(255, 160, 80, 0.12);
  --ms-ui-shadow: rgba(20, 8, 0, 0.48);
  --ms-ui-text: rgba(255, 235, 210, 0.96);
  --ms-ui-text-muted: rgba(240, 210, 175, 0.9);
  --ms-ui-text-faint: rgba(210, 170, 130, 0.72);
  --ms-ui-border: rgba(255, 170, 90, 0.16);
  --ms-ui-border-strong: rgba(255, 190, 110, 0.26);
  --ms-ui-border-focus: rgba(255, 160, 70, 0.6);
  --ms-ui-surface: rgba(255, 150, 70, 0.08);
  --ms-ui-surface-hover: rgba(255, 160, 80, 0.14);
  --ms-ui-surface-active: rgba(255, 170, 90, 0.18);
  --ms-ui-input-bg: rgba(255, 140, 60, 0.12);
  --ms-ui-input-bg-hover: rgba(255, 150, 70, 0.18);
  --ms-ui-toolbar-start: #342418;
  --ms-ui-toolbar-end: #2a1c12;
  --ms-ui-status-start: #3a281c;
  --ms-ui-status-end: #302014;
  --ms-ui-scrollbar-thumb: rgba(255, 190, 120, 0.55);
  --ms-ui-scrollbar-track: rgba(30, 15, 5, 0.55);
  --ms-ui-scrollbar-thumb-hover: rgba(255, 210, 150, 0.82);
  --ms-ui-accent: rgba(255, 170, 70, 0.98);
  --ms-ui-success: #8ae878;
  --ms-ui-success-bg: rgba(60, 130, 50, 0.22);
  --ms-ui-success-border: rgba(120, 220, 100, 0.48);
  --ms-ui-success-text: rgba(230, 255, 220, 0.98);
  --ms-ui-danger: rgba(255, 210, 210, 0.95);
  --ms-ui-danger-bg: rgba(120, 30, 10, 0.28);
  --ms-ui-danger-border: rgba(255, 100, 70, 0.48);
  --ms-ui-danger-bg-hover: rgba(140, 20, 20, 0.26);
  --ms-ui-danger-border-hover: rgba(255, 140, 140, 0.5);
  --ms-ui-off-bg: rgba(120, 40, 20, 0.24);
  --ms-ui-off-border: rgba(240, 120, 80, 0.45);
  --ms-ui-off-text: rgba(255, 220, 215, 0.96);
  --ms-ui-off-dot: #e87060;
  --ms-ui-filter-match: rgba(255, 210, 100, 0.98);
  --ms-ui-filter-match-bg: rgba(255, 160, 60, 0.18);
  --ms-ui-link-bug: #88c8ff;
  --ms-ui-link-patreon: #ff424d;
  --ms-ui-link-store: #ff6400;
  --ms-ui-folder-lighting: rgba(255, 180, 90, 0.5);
  --ms-ui-folder-grade: rgba(255, 220, 130, 0.55);
  --ms-ui-select-option-bg: #221810;
  --ms-ui-divider-mid: rgba(255, 160, 80, 0.12);
  --ms-ui-divider-edge: rgba(180, 100, 40, 0.06);`,

  'high-contrast': `
  color-scheme: dark;
  --tp-base-background-color: #000000;
  --tp-base-border-radius: 4px;
  --tp-base-shadow-color: rgba(255, 255, 255, 0.15);
  --tp-base-font-family: var(--font-primary, 'Signika', sans-serif);
  --tp-button-background-color: #ffff00;
  --tp-button-background-color-hover: #ffff66;
  --tp-button-background-color-focus: #ffff99;
  --tp-button-background-color-active: #ffffcc;
  --tp-button-foreground-color: #000000;
  --tp-container-background-color: #1a1a1a;
  --tp-container-background-color-hover: #262626;
  --tp-container-background-color-focus: #333333;
  --tp-container-background-color-active: #404040;
  --tp-container-foreground-color: #ffffff;
  --tp-input-background-color: #0d0d0d;
  --tp-input-background-color-hover: #1a1a1a;
  --tp-input-background-color-focus: #262626;
  --tp-input-background-color-active: #333333;
  --tp-input-foreground-color: #ffffff;
  --tp-label-foreground-color: #ffffff;
  --tp-monitor-background-color: #000000;
  --tp-monitor-foreground-color: #ffff00;
  --tp-groove-foreground-color: #ffffff;
  --ms-ui-shadow: rgba(255, 255, 255, 0.2);
  --ms-ui-text: #ffffff;
  --ms-ui-text-muted: #f0f0f0;
  --ms-ui-text-faint: #cccccc;
  --ms-ui-border: #ffffff;
  --ms-ui-border-strong: #ffffff;
  --ms-ui-border-focus: #ffff00;
  --ms-ui-surface: #111111;
  --ms-ui-surface-hover: #222222;
  --ms-ui-surface-active: #333333;
  --ms-ui-input-bg: #0a0a0a;
  --ms-ui-input-bg-hover: #1a1a1a;
  --ms-ui-toolbar-start: #000000;
  --ms-ui-toolbar-end: #111111;
  --ms-ui-status-start: #000000;
  --ms-ui-status-end: #111111;
  --ms-ui-scrollbar-thumb: #ffff00;
  --ms-ui-scrollbar-track: #222222;
  --ms-ui-scrollbar-thumb-hover: #ffffff;
  --ms-ui-accent: #ffff00;
  --ms-ui-success: #00ff66;
  --ms-ui-success-bg: #003318;
  --ms-ui-success-border: #00ff66;
  --ms-ui-success-text: #ffffff;
  --ms-ui-danger: #ffffff;
  --ms-ui-danger-bg: #440000;
  --ms-ui-danger-border: #ff4444;
  --ms-ui-danger-bg-hover: #660000;
  --ms-ui-danger-border-hover: #ff6666;
  --ms-ui-off-bg: #330000;
  --ms-ui-off-border: #ff6666;
  --ms-ui-off-text: #ffffff;
  --ms-ui-off-dot: #ff4444;
  --ms-ui-filter-match: #ffff00;
  --ms-ui-filter-match-bg: #333300;
  --ms-ui-link-bug: #66ccff;
  --ms-ui-link-patreon: #ff6666;
  --ms-ui-link-store: #ffaa00;
  --ms-ui-folder-lighting: #00ccff;
  --ms-ui-folder-grade: #ffff00;
  --ms-ui-select-option-bg: #000000;
  --ms-ui-divider-mid: #ffffff;
  --ms-ui-divider-edge: #666666;`,

  'soft-light': `
  color-scheme: light;
  --tp-base-background-color: #ece8df;
  --tp-base-border-radius: 6px;
  --tp-base-shadow-color: rgba(0, 0, 0, 0.12);
  --tp-base-font-family: var(--font-primary, 'Signika', sans-serif);
  --tp-button-background-color: #2f5f9a;
  --tp-button-background-color-hover: #3a6fad;
  --tp-button-background-color-focus: #457fc0;
  --tp-button-background-color-active: #508fd3;
  --tp-button-foreground-color: #ffffff;
  --tp-container-background-color: rgba(0, 0, 0, 0.05);
  --tp-container-background-color-hover: rgba(0, 0, 0, 0.08);
  --tp-container-background-color-focus: rgba(0, 0, 0, 0.10);
  --tp-container-background-color-active: rgba(0, 0, 0, 0.12);
  --tp-container-foreground-color: #1a1a1a;
  --tp-input-background-color: rgba(255, 255, 255, 0.85);
  --tp-input-background-color-hover: rgba(255, 255, 255, 0.95);
  --tp-input-background-color-focus: #ffffff;
  --tp-input-background-color-active: #ffffff;
  --tp-input-foreground-color: #1a1a1a;
  --tp-label-foreground-color: rgba(30, 30, 30, 0.78);
  --tp-monitor-background-color: rgba(0, 0, 0, 0.06);
  --tp-monitor-foreground-color: rgba(20, 20, 20, 0.82);
  --tp-groove-foreground-color: rgba(0, 0, 0, 0.10);
  --ms-ui-shadow: rgba(0, 0, 0, 0.15);
  --ms-ui-text: #1a1a1a;
  --ms-ui-text-muted: rgba(30, 30, 30, 0.88);
  --ms-ui-text-faint: rgba(40, 40, 40, 0.65);
  --ms-ui-border: rgba(0, 0, 0, 0.18);
  --ms-ui-border-strong: rgba(0, 0, 0, 0.28);
  --ms-ui-border-focus: rgba(47, 95, 154, 0.75);
  --ms-ui-surface: rgba(255, 255, 255, 0.55);
  --ms-ui-surface-hover: rgba(255, 255, 255, 0.75);
  --ms-ui-surface-active: rgba(255, 255, 255, 0.9);
  --ms-ui-input-bg: rgba(255, 255, 255, 0.82);
  --ms-ui-input-bg-hover: rgba(255, 255, 255, 0.95);
  --ms-ui-toolbar-start: #e4e0d6;
  --ms-ui-toolbar-end: #d8d4ca;
  --ms-ui-status-start: #e8e4da;
  --ms-ui-status-end: #dcd8ce;
  --ms-ui-scrollbar-thumb: rgba(60, 60, 60, 0.45);
  --ms-ui-scrollbar-track: rgba(0, 0, 0, 0.08);
  --ms-ui-scrollbar-thumb-hover: rgba(40, 40, 40, 0.65);
  --ms-ui-accent: #b85c00;
  --ms-ui-success: #187a3a;
  --ms-ui-success-bg: rgba(24, 122, 58, 0.14);
  --ms-ui-success-border: rgba(24, 122, 58, 0.45);
  --ms-ui-success-text: #0f4020;
  --ms-ui-danger: #6a1010;
  --ms-ui-danger-bg: rgba(180, 40, 40, 0.12);
  --ms-ui-danger-border: rgba(180, 40, 40, 0.45);
  --ms-ui-danger-bg-hover: rgba(180, 40, 40, 0.2);
  --ms-ui-danger-border-hover: rgba(180, 40, 40, 0.6);
  --ms-ui-off-bg: rgba(180, 50, 40, 0.12);
  --ms-ui-off-border: rgba(160, 50, 40, 0.4);
  --ms-ui-off-text: #5a1810;
  --ms-ui-off-dot: #c04030;
  --ms-ui-filter-match: #8a5000;
  --ms-ui-filter-match-bg: rgba(184, 92, 0, 0.14);
  --ms-ui-link-bug: #1a5fb4;
  --ms-ui-link-patreon: #c91828;
  --ms-ui-link-store: #c85000;
  --ms-ui-folder-lighting: rgba(47, 95, 154, 0.55);
  --ms-ui-folder-grade: rgba(184, 92, 0, 0.55);
  --ms-ui-select-option-bg: #f5f2ea;
  --ms-ui-divider-mid: rgba(0, 0, 0, 0.10);
  --ms-ui-divider-edge: rgba(0, 0, 0, 0.04);`,
});

/**
 * @param {string} [schemeId]
 * @returns {string}
 */
export function normalizeUiColorSchemeId(schemeId) {
  const id = typeof schemeId === 'string' ? schemeId.trim() : '';
  return SCHEME_IDS.has(id) ? id : DEFAULT_UI_COLOR_SCHEME_ID;
}

/**
 * @returns {Array<{ value: string, text: string }>}
 */
export function getUiColorSchemeListOptions() {
  return UI_COLOR_SCHEMES.map((scheme) => ({
    value: scheme.id,
    text: scheme.accessibility ? `${scheme.label} (accessibility)` : scheme.label,
  }));
}

/**
 * @param {string} schemeId
 * @returns {UiColorSchemeDef|null}
 */
export function getUiColorSchemeDef(schemeId) {
  const id = normalizeUiColorSchemeId(schemeId);
  return UI_COLOR_SCHEMES.find((s) => s.id === id) ?? null;
}

/**
 * @returns {HTMLStyleElement}
 */
function ensureRuntimeThemeStyleEl() {
  let el = document.getElementById(RUNTIME_STYLE_ID);
  if (el instanceof HTMLStyleElement) return el;

  el = document.createElement('style');
  el.id = RUNTIME_STYLE_ID;
  document.head.appendChild(el);
  return el;
}

/**
 * @param {string} resolved
 */
function injectRuntimeThemeCss(resolved) {
  const tokens = THEME_TOKEN_BLOCKS[resolved] ?? THEME_TOKEN_BLOCKS[DEFAULT_UI_COLOR_SCHEME_ID];
  const styleEl = ensureRuntimeThemeStyleEl();
  styleEl.textContent = `${HOST_SELECTOR_LIST} {${tokens}\n}`;
}

/**
 * Tag mounted Tweakpane host roots for auxiliary CSS (high-contrast borders, etc.).
 * @param {string} resolved
 */
function syncThemeHostAttributes(resolved) {
  try {
    document.documentElement.setAttribute('data-ms-ui-theme', resolved);
  } catch (_) {}

  for (const selector of UI_COLOR_SCHEME_ROOT_SELECTORS) {
    try {
      const el = document.querySelector(selector);
      if (el) el.setAttribute('data-ms-ui-theme', resolved);
    } catch (_) {}
  }
}

/**
 * Re-apply the active scheme to any hosts that mounted after the last apply call.
 * @param {string} [schemeId]
 */
export function syncUiColorSchemeHosts(schemeId) {
  const resolved = normalizeUiColorSchemeId(
    schemeId ?? window.MapShine?.__uiColorScheme ?? DEFAULT_UI_COLOR_SCHEME_ID
  );
  syncThemeHostAttributes(resolved);
}

/**
 * Apply a colour scheme to all module Tweakpane host containers.
 * @param {string} [schemeId]
 * @returns {string} Resolved scheme id
 */
export function applyUiColorScheme(schemeId) {
  const resolved = normalizeUiColorSchemeId(schemeId);
  injectRuntimeThemeCss(resolved);
  syncThemeHostAttributes(resolved);

  try {
    if (window.MapShine) window.MapShine.__uiColorScheme = resolved;
  } catch (_) {}

  return resolved;
}
