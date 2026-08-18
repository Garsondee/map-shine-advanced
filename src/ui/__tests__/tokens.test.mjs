/**
 * The WCAG contrast gate — U0's exit criterion (docs/holy/UI-Testament.md §9)
 * is "a standalone widget-gallery harness renders every widget in all 4
 * themes; contrast test green," and this is that second half. A palette edit
 * that quietly drifts `--ink2` too close to `--bg2` in one theme is not a
 * mistake anyone SEES while editing three-and-away hex triplets by eye — this
 * makes it a red assertion instead.
 *
 * Only SOLID colour tokens are checked. `--line`/`--shine-soft`/`--shine-glow`
 * etc. are deliberately translucent decoration — their contrast depends on
 * whatever they are composited over, which this test cannot know, so
 * "checking" them would be measuring the wrong thing. What is checked is
 * exactly the token pairs `tools/ui-mock/index.html`'s own CSS actually
 * composites: which foreground token rides on which background token, taken
 * from the mock's real selectors, not an exhaustive (and largely meaningless)
 * cross-product of every token against every other one.
 */
import { THEMES, getThemeTokens } from '../tokens.js';

/**
 * Relative luminance (WCAG 2.x, sRGB). @param {[number,number,number]} rgb
 * @returns {number}
 */
function relLuminance([r, g, b]) {
  const [R, G, B] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** WCAG contrast ratio between two OPAQUE colours, always >= 1. */
function contrastRatio(rgbA, rgbB) {
  const [light, dark] = [relLuminance(rgbA), relLuminance(rgbB)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** `#rrggbb` (the only solid-colour shape every token below uses) → `[r,g,b]`. Throws on anything else — a token that turned translucent belongs out of this list, not silently mis-measured. */
function hexToRgb(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`contrast gate: '${hex}' is not a solid #rrggbb colour`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `rgba(r,g,b,a)` → `[r,g,b,a]`, `a` in 0..1. */
function parseRgba(str) {
  const m = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(str);
  if (!m) throw new Error(`contrast gate: '${str}' is not an rgba(...) colour`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

/**
 * Paint a translucent `rgba(...)` token over an opaque `#rrggbb` backdrop and
 * return the resulting OPAQUE colour — the same "what does the eye actually
 * see" compositing the browser itself does. Needed because every "shine text"
 * pairing in the real CSS (`.btn.gold`, `.chip[aria-pressed]`, `.tab[aria-
 * pressed]`, `.hbtn[aria-pressed]`) sits on `--shine-soft`, never on a flat
 * `--bg*` — checking shine text against bare `--bg2` tests a combination the
 * design never actually presents.
 * @param {string} rgbaStr @param {string} hexBackdrop @returns {[number,number,number]}
 */
function compositeOverHex(rgbaStr, hexBackdrop) {
  const [r, g, b, a] = parseRgba(rgbaStr);
  const [br, bg, bb] = hexToRgb(hexBackdrop);
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
}

/**
 * [foreground token, background description, minimum ratio, role]. Ratios:
 * 4.5 is WCAG AA for normal-size text; 3.0 is AA for large text and for
 * UI/graphical components (icons, status dots, active-state borders — which
 * convey meaning but are not paragraphs to read). Background is either a
 * plain token name (an opaque `--bg*` surface, taken as-is) or `{soft: token}`
 * meaning "that token's `-soft` wash, composited over `--bg2`" — the real
 * backdrop `--shine`-as-text always appears on in the mock's own CSS (see
 * `.btn.gold`, `.chip[aria-pressed]`, `.tab[aria-pressed]`, `.hbtn[aria-
 * pressed]`: background is always `var(--shine-soft)`, never a bare `--bg*`).
 */
const PAIRS = [
  ['--ink0', '--bg0', 4.5, 'body text on the page backdrop'],
  ['--ink0', '--bg2', 4.5, 'primary text on a control surface (inputs, selects)'],
  ['--ink1', '--bg1', 4.5, 'room-head titles / secondary text on a room surface'],
  ['--ink1', '--bg2', 4.5, 'chip/tab secondary text on a control surface'],
  ['--ink2', '--bg2', 3.0, 'muted tertiary text — decorative weight, not a paragraph'],
  // `.rtitle .ico{color:var(--shine)}` — an ICON, not text: non-text/UI
  // component contrast (WCAG 1.4.11) is 3:1, not the 4.5:1 text minimum.
  ['--shine', '--bg1', 3.0, 'accent icon (.rtitle .ico) on a room surface'],
  // `.btn.gold`/`.chip[aria-pressed]`/`.tab[aria-pressed]` etc: shine TEXT,
  // but always on `--shine-soft`'s wash, never on a bare surface — composited
  // per-theme below, not listed as a flat token pair.
  ['--ok', '--bg2', 3.0, 'status colour as an indicator, not body text'],
  ['--warn', '--bg2', 3.0, 'status colour as an indicator'],
  ['--fail', '--bg2', 3.0, 'status colour as an indicator'],
  ['--info', '--bg2', 3.0, 'status colour as an indicator'],
];

export function run(t) {
  t.ok('THEMES lists exactly the four LANTERN themes', THEMES.join(',') === 'dark,light,hc,soft');

  for (const theme of THEMES) {
    const tokens = getThemeTokens(theme);
    for (const [fg, bg, minRatio, role] of PAIRS) {
      const ratio = contrastRatio(hexToRgb(tokens[fg]), hexToRgb(tokens[bg]));
      t.ok(
        `[${theme}] ${fg} on ${bg} (${role}) clears ${minRatio}:1 — measured ${ratio.toFixed(2)}:1`,
        ratio >= minRatio
      );
    }

    // shine-as-text-on-its-own-soft-wash — the pairing every pressed/active
    // gold control in the design actually uses.
    const softBackdrop = compositeOverHex(tokens['--shine-soft'], tokens['--bg2']);
    const shineOnSoft = contrastRatio(hexToRgb(tokens['--shine']), softBackdrop);
    t.ok(
      `[${theme}] --shine text on its own --shine-soft wash (.btn.gold etc) clears 4.5:1 — measured ${shineOnSoft.toFixed(2)}:1`,
      shineOnSoft >= 4.5
    );
  }

  // A theme that silently loses a token (typo'd key on a future edit) must
  // fail loudly here rather than pass by accident because hexToRgb threw and
  // nobody noticed the exception wasn't a `t.ok(false, ...)`.
  t.ok(
    'every theme declares every token this gate checks (no accidental omission)',
    THEMES.every((theme) => {
      const tokens = getThemeTokens(theme);
      return (
        PAIRS.every(([fg, bg]) => typeof tokens[fg] === 'string' && typeof tokens[bg] === 'string') &&
        typeof tokens['--shine-soft'] === 'string'
      );
    })
  );

  t.ok(
    'an unknown theme throws rather than silently falling back to dark',
    (() => {
      try {
        getThemeTokens('nonexistent');
        return false;
      } catch (e) {
        return /unknown theme/.test(String(e.message));
      }
    })()
  );
}
