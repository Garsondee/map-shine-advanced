/**
 * GRID — MSA's own grid look: thin, quiet, legible by day and by night.
 *
 * The author, 2026-11-02: *"a nice, subtle, thin but elegant grid which works both at night and during
 * the day. Then set that as the default grid that gets rendered with an effect card so that the GM can
 * change the world default values for all scenes."*
 *
 * WHAT IT CHANGES, AND WHAT IT NEVER DOES: only how the lines LOOK. Where they are — square or hex, the
 * grid size, the offset, gridless — stays Foundry's scene config, so measurement, snapping and every
 * module reading `canvas.grid` agree with what is drawn. Hiding the grid in Foundry (gridless, line
 * thickness 0, opacity 0) hides it here too. With this effect OFF, MSA draws Foundry's own configured
 * grid exactly (`effects/grid/foundry-grid-render.js#buildFoundryGridAlpha`).
 *
 * WHY IT READS AT NIGHT AND BY DAY: a fixed-colour line is either lost on dark ground (black lines) or
 * glaring on bright ground (white lines). This line is INK chosen per pixel from the finished picture
 * under it: on bright ground a dark umber ink, on dark ground a pale parchment ink, crossing over
 * smoothly at `pivot` (display luminance). Each side has its own opacity, because a pale line on a
 * night map catches the eye far more than a dark line on a sunny one.
 *
 * WHY IT STAYS THIN: the width is in SCREEN pixels, so a line is a hairline at every zoom (Foundry's
 * width is in map pixels and thickens as you zoom in). Zoomed far out, where squares shrink to a few
 * pixels and a grid turns into a grey haze, the lines fade away (`fadeBelowPx`).
 *
 * WORLD DEFAULTS: the card's values are a WORLD setting (`foundry/grid-defaults-persistence.js`), not a
 * scene flag, so one GM edit restyles the grid on every scene for everyone at the table.
 *
 * @module effects/grid/grid
 */

/** The line patterns the look offers. */
export const GRID_LINE_STYLES = Object.freeze(['solid', 'dashed', 'dotted']);

/** The effect's Studio parameters, in card order. */
export const GRID_PARAMS = Object.freeze({
  // ── Line ────────────────────────────────────────────────────────────────
  lineStyle: {
    type: 'enum',
    values: [...GRID_LINE_STYLES],
    default: 'solid',
    category: 'Line',
    label: 'Line',
    help: 'Solid, dashed or dotted lines. Square or hex comes from the scene’s own grid settings.',
  },
  widthPx: {
    type: 'float',
    min: 0.5,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Line',
    label: 'Width',
    help: 'Line width in screen pixels. It stays the same at every zoom, so the grid never thickens as you zoom in.',
  },
  fadeBelowPx: {
    type: 'float',
    min: 0,
    max: 80,
    step: 1,
    default: 28,
    category: 'Line',
    label: 'Fade when squares are smaller than',
    help: 'Zoomed far out, squares smaller than this (in screen pixels) fade the grid away instead of greying the map over. 0 never fades.',
  },
  // ── Day and night ───────────────────────────────────────────────────────
  dayOpacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.34,
    category: 'Day and night',
    label: 'Opacity on bright ground',
    help: 'How strong the dark ink is where the map is bright (daylight, lit rooms).',
  },
  nightOpacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.16,
    category: 'Day and night',
    label: 'Opacity on dark ground',
    help: 'How strong the pale ink is where the map is dark (night, unlit rooms, fog). Keep it lower than the day opacity: a pale line on a dark map catches the eye far more.',
  },
  darkInk: {
    type: 'color',
    space: 'srgb',
    default: '#1c1712',
    category: 'Day and night',
    label: 'Ink on bright ground',
    help: 'The line colour on bright ground. A warm near-black reads as drawn on the map rather than laid over it.',
  },
  lightInk: {
    type: 'color',
    space: 'srgb',
    default: '#efe6d2',
    category: 'Day and night',
    label: 'Ink on dark ground',
    help: 'The line colour on dark ground. A warm parchment white stays soft at night.',
  },
  pivot: {
    type: 'float',
    min: 0.05,
    max: 0.95,
    step: 0.01,
    default: 0.32,
    category: 'Day and night',
    label: 'Switch-over brightness',
    help: 'How bright the ground must be (0 = black, 1 = white) before the dark ink takes over from the pale one. The change is gradual either side.',
  },
});

export const GRID = Object.freeze({
  id: 'grid',
  title: 'Grid',
  visualWeight: 0.05,
  a11y: Object.freeze({ photosensitive: false }),
  // On for everyone by default: it is the grid MSA draws unless a GM turns the card off.
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: false,
    coverage: 'none',
    why: 'Closed-form maths folded into the present draw: no texture, no asset, no pass of its own.',
  }),
  params: GRID_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'adaptive-hairline',
      cost: Object.freeze({ class: 'C0', estMsPerMp: 0.01 }),
      adds: "a screen-pixel-thin grid on Foundry's own grid geometry, inked dark on bright ground and pale on dark ground, fading away when zoomed far out",
    }),
  ]),
});

/** `'#rrggbb'` → display-space [r, g, b] in 0..1 (anything else: null). */
export function gridInkRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/**
 * The grid look the present draws, from the card's resolved params (missing or invalid values fall
 * back to the defaults above). Pure.
 * @param {Record<string, unknown>|null|undefined} params
 */
export function resolveGridLook(params) {
  const p = params ?? {};
  const num = (k) => {
    const d = GRID_PARAMS[k];
    const v = Number(p[k]);
    return Number.isFinite(v) ? Math.min(d.max, Math.max(d.min, v)) : d.default;
  };
  const style = GRID_LINE_STYLES.includes(p.lineStyle) ? p.lineStyle : GRID_PARAMS.lineStyle.default;
  return {
    lineStyle: style,
    widthPx: num('widthPx'),
    fadeBelowPx: num('fadeBelowPx'),
    dayOpacity: num('dayOpacity'),
    nightOpacity: num('nightOpacity'),
    darkInk: gridInkRgb(p.darkInk) ?? gridInkRgb(GRID_PARAMS.darkInk.default),
    lightInk: gridInkRgb(p.lightInk) ?? gridInkRgb(GRID_PARAMS.lightInk.default),
    pivot: num('pivot'),
  };
}
