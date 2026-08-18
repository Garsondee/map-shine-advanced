/**
 * ui/tokens.js — the LANTERN token set (docs/holy/UI-Testament.md §6), ported
 * verbatim from `tools/ui-mock/index.html`'s own `:root`/`html[data-theme]`
 * block — the mock's header calls those values "the calibration draft that
 * seeds src/ui/tokens.js at U0," so this file is a PORT, not a redesign: every
 * value below is copied, not retuned. If a value ever needs retuning, do it
 * here AND in the mock, in the same commit — this file has no automatic way
 * to know the mock drifted.
 *
 * Four themes (dark/light/hc/soft), one shared set of shape/motion tokens.
 * `installTokens()` injects them as a `<style>` tag, matching the established
 * `injectStyle()` pattern (`ui/camera-path-dialog.js`, `diag/debug-panel.js`):
 * idempotent by element id, plain `document.createElement('style')`, no build
 * step. `getThemeTokens()` exposes the same data as plain JS objects for
 * anything that needs to READ a value rather than just render it — the WCAG
 * contrast gate (`__tests__/tokens.test.mjs`) is the first such consumer.
 *
 * @module ui/tokens
 */

const STYLE_ID = 'msa-lantern-tokens';

/** The four LANTERN themes, in the order they should appear in any theme picker. */
export const THEMES = Object.freeze(['dark', 'light', 'hc', 'soft']);

/** Shape, spacing, motion — theme-independent, one value for all four themes. */
const SHARED = Object.freeze({
  '--font': '"Segoe UI", system-ui, -apple-system, sans-serif',
  '--mono': '"Cascadia Mono", ui-monospace, Consolas, monospace',
  '--r-ctl': '6px',
  '--r-card': '10px',
  '--r-room': '14px',
  '--sp1': '4px',
  '--sp2': '8px',
  '--sp3': '12px',
  '--sp4': '16px',
  '--sp5': '24px',
  '--t-micro': '120ms',
  '--t-move': '200ms',
  '--t-room': '320ms',
  '--ease': 'cubic-bezier(.22,.7,.3,1)',
});

/**
 * Per-theme colour/glass/shadow tokens. Property order matches the mock's own
 * `:root` block so a future diff against `tools/ui-mock/index.html` reads
 * line-for-line.
 * @type {Readonly<Record<'dark'|'light'|'hc'|'soft', Readonly<Record<string, string>>>>}
 */
const THEME_TOKENS = Object.freeze({
  dark: Object.freeze({
    '--bg0': '#14161d',
    '--bg1': '#191c25',
    '--bg2': '#20242f',
    '--bg3': '#272c3a',
    '--line': 'rgba(196,208,232,.13)',
    '--line-strong': 'rgba(196,208,232,.24)',
    '--ink0': '#ecEFf5',
    '--ink1': '#a8b1c2',
    '--ink2': '#78829a',
    '--shine': '#e7c368',
    '--shine-soft': 'rgba(231,195,104,.16)',
    '--shine-glow': 'rgba(231,195,104,.38)',
    '--ok': '#4bd48c',
    '--warn': '#edb64f',
    '--fail': '#ef6d5a',
    '--info': '#58a6f2',
    '--c-gameplay': '#3fd3b4',
    '--c-lighting': '#f0b64a',
    '--c-atmos': '#5aa9f2',
    '--c-surface': '#b48af5',
    '--c-particles': '#f28a4a',
    '--c-post': '#ef6aa8',
    '--c-system': '#8fa0b8',
    '--glass': 'rgba(25,28,37,.86)',
    '--glass-blur': '14px',
    '--shadow1': '0 2px 10px rgba(0,0,0,.35)',
    '--shadow2': '0 8px 30px rgba(0,0,0,.45)',
    '--shadow3': '0 18px 60px rgba(0,0,0,.55)',
    '--glow-on': '1',
    '--map-bright': '1',
  }),
  light: Object.freeze({
    '--bg0': '#e8eaf0',
    '--bg1': '#f2f4f8',
    '--bg2': '#ffffff',
    '--bg3': '#eef1f6',
    '--line': 'rgba(30,42,70,.14)',
    '--line-strong': 'rgba(30,42,70,.28)',
    '--ink0': '#1d2333',
    '--ink1': '#4c5670',
    '--ink2': '#7d869c',
    // Darkened from the mock's draft #a5761c (same hue, ~82% value) — U0's own
    // contrast gate (__tests__/tokens.test.mjs) measured shine-on-its-own-
    // shine-soft-wash (the real `.btn.gold`/`.chip[aria-pressed]`/`.tab[aria-
    // pressed]` pairing) at 3.47:1 against light's near-white surfaces, short
    // of WCAG AA's 4.5:1. #876117 measures 4.81:1 on the same pairing — one
    // number changed, same colour family, headroom instead of a red test.
    '--shine': '#876117',
    '--shine-soft': 'rgba(135,97,23,.13)',
    '--shine-glow': 'rgba(135,97,23,.30)',
    '--ok': '#178f55',
    '--warn': '#a97b14',
    '--fail': '#c44432',
    '--info': '#2a72c8',
    '--c-gameplay': '#0f9c80',
    '--c-lighting': '#b07f14',
    '--c-atmos': '#2a72c8',
    '--c-surface': '#7a4fd0',
    '--c-particles': '#c25c1a',
    '--c-post': '#c23a78',
    '--c-system': '#5d6c86',
    '--glass': 'rgba(246,248,251,.92)',
    '--glass-blur': '14px',
    '--shadow1': '0 2px 10px rgba(30,40,70,.14)',
    '--shadow2': '0 8px 30px rgba(30,40,70,.18)',
    '--shadow3': '0 18px 60px rgba(30,40,70,.22)',
    '--glow-on': '1',
    '--map-bright': '1',
  }),
  hc: Object.freeze({
    '--bg0': '#000000',
    '--bg1': '#0a0a0c',
    '--bg2': '#131318',
    '--bg3': '#1c1c24',
    '--line': 'rgba(255,255,255,.38)',
    '--line-strong': 'rgba(255,255,255,.6)',
    '--ink0': '#ffffff',
    '--ink1': '#e6e6ee',
    '--ink2': '#b8b8c8',
    '--shine': '#ffd75e',
    '--shine-soft': 'rgba(255,215,94,.22)',
    '--shine-glow': 'rgba(255,215,94,.5)',
    '--ok': '#39e58c',
    '--warn': '#ffc93c',
    '--fail': '#ff7a63',
    '--info': '#6cb8ff',
    '--c-gameplay': '#31e8c2',
    '--c-lighting': '#ffc93c',
    '--c-atmos': '#6cb8ff',
    '--c-surface': '#c89cff',
    '--c-particles': '#ff9a5c',
    '--c-post': '#ff7ab8',
    '--c-system': '#b8c4d8',
    '--glass': 'rgba(6,6,9,.94)',
    '--glass-blur': '8px',
    '--shadow1': '0 0 0 1px var(--line)',
    '--shadow2': '0 0 0 1px var(--line-strong)',
    '--shadow3': '0 0 0 2px var(--line-strong)',
    '--glow-on': '1',
    '--map-bright': '1',
  }),
  soft: Object.freeze({
    '--bg0': '#1a1c21',
    '--bg1': '#1f2127',
    '--bg2': '#26282f',
    '--bg3': '#2d3038',
    '--line': 'rgba(190,196,210,.10)',
    '--line-strong': 'rgba(190,196,210,.20)',
    '--ink0': '#d8dbe2',
    '--ink1': '#9aa0ad',
    '--ink2': '#6f7583',
    '--shine': '#c2a878',
    '--shine-soft': 'rgba(194,168,120,.12)',
    '--shine-glow': 'rgba(194,168,120,.0)',
    '--ok': '#7fb99a',
    '--warn': '#c2a878',
    '--fail': '#c08a80',
    '--info': '#89a7c8',
    '--c-gameplay': '#7ab8a9',
    '--c-lighting': '#c2a878',
    '--c-atmos': '#8aa8c8',
    '--c-surface': '#a794c8',
    '--c-particles': '#c2977a',
    '--c-post': '#c088a5',
    '--c-system': '#98a2b2',
    '--glass': 'rgba(31,33,39,.9)',
    '--glass-blur': '10px',
    '--shadow1': '0 2px 8px rgba(0,0,0,.25)',
    '--shadow2': '0 6px 20px rgba(0,0,0,.3)',
    '--shadow3': '0 12px 40px rgba(0,0,0,.35)',
    '--glow-on': '0',
    '--map-bright': '.92',
  }),
});

/**
 * A theme's full token set as a plain object (`{'--bg0': '#14161d', ...}`),
 * shared tokens merged in. Throws on an unknown theme — a typo'd theme name
 * silently falling back to `dark` is how a future 5th theme goes unnoticed.
 * @param {string} theme
 * @returns {Readonly<Record<string, string>>}
 */
export function getThemeTokens(theme) {
  if (!THEME_TOKENS[theme]) {
    throw new Error(`ui/tokens: unknown theme '${theme}' — expected one of: ${THEMES.join(', ')}`);
  }
  return Object.freeze({ ...SHARED, ...THEME_TOKENS[theme] });
}

function ruleFor(selector, tokens) {
  const body = Object.entries(tokens)
    .map(([k, v]) => `${k}:${v};`)
    .join('');
  return `${selector}{${body}}`;
}

/**
 * The Accessibility Charter items (docs/holy/UI-Testament.md §7) cheap and
 * SAFE enough to ship globally, the moment U0 lands, without waiting for a
 * room container to exist to scope them to:
 *  - `.ico`/`.num` — base classes `ui/widgets/icon-sprite.js` and the param
 *    canon's readouts assume exist (ported from the mock's own base layer;
 *    without this, every icon renders unstyled — found live, U0 round).
 *  - `:focus-visible` (Charter §7.3) — PURELY ADDITIVE: only adds a ring on
 *    keyboard focus, never removes one, so it cannot regress the OLD debug-
 *    panel's own default focus outlines if both are ever mounted at once
 *    during the side-by-side rollout. Deliberately NOT paired with the mock's
 *    own `:focus{outline:none}` reset — that rule is unscoped (global,
 *    keyed off nothing but `<html>`) and WOULD strip the old panel's outlines
 *    the moment any new room calls `installTokens()` on the same page; it
 *    belongs to whichever room-container work first gives "new UI" elements
 *    something reliable to scope a reset to, not to the token foundation.
 *  - reduced motion (Charter §7.5) — same reasoning: `@media` and the
 *    `data-reduce-motion` attribute variant only ever SHORTEN motion, never
 *    add any, and the attribute is inert until something sets it.
 * Deliberately NOT included: keyboard STEP behaviour (Shift=fine/PgUp-Dn=
 * coarse on every slider, arrow-key bearing on the compass dial, Esc/tab-
 * order) — real, remaining Charter §7.3 work, honestly open in Petition P9,
 * not silently skipped.
 */
const BASE_CSS = `
.ico{width:1.1em;height:1.1em;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;vertical-align:-0.18em;flex:none}
.num{font-variant-numeric:tabular-nums}
:focus-visible{outline:2px solid var(--shine, #e7c368);outline-offset:2px;border-radius:4px}
html[data-reduce-motion="1"] *,html[data-reduce-motion="1"] *::before,html[data-reduce-motion="1"] *::after{animation-duration:0.001s !important;transition-duration:0.001s !important}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:0.001s !important;transition-duration:0.001s !important}}
`.trim();

/**
 * The full LANTERN stylesheet text — `:root` (shared tokens), one
 * `html[data-theme="..."]` rule per theme (in `THEMES` order), then
 * {@link BASE_CSS}. Exported (not just used internally by `installTokens`) so
 * the widget-gallery harness can embed the identical rules in a standalone
 * HTML file without also pulling in a live DOM `<style>` injection.
 * @returns {string}
 */
export function tokensCSS() {
  const rules = [ruleFor(':root', SHARED)];
  for (const theme of THEMES) rules.push(ruleFor(`html[data-theme="${theme}"]`, THEME_TOKENS[theme]));
  rules.push(BASE_CSS);
  return rules.join('\n');
}

/**
 * Install the LANTERN stylesheet into the current document, once. Safe to
 * call from every room/widget module that depends on these tokens — the
 * `getElementById` guard makes every call after the first a no-op, so nobody
 * needs to track "did tokens already load" themselves.
 */
export function installTokens() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = tokensCSS();
  document.head.appendChild(el);
}
