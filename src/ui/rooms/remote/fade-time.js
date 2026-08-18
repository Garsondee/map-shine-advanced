/**
 * ui/rooms/remote/fade-time.js — the Fade Time segmented control (Testament
 * §4.1's own row: "Now · 10s · 1m · 5m · 15m · 1h... every subsequent
 * gesture... eases over the selected tempo"). U2 checkpoint 3.
 *
 * Exactly the mock's own 6 entries (confirmed by reading `tools/ui-mock/
 * index.html`'s `TEMPO` array directly, Petition P11's own mock research) —
 * no 7th "custom" option exists there and none is built here either.
 *
 * A tiny, standalone piece of shared state: whichever gesture starts a fade
 * (a mood chip, Baseline, a future cue) reads `getOverMs()` at the moment it
 * fires, rather than each gesture keeping its own copy of "how long" (the
 * exact mirror-state Environment.md §2.4 warns about, one level up).
 *
 * @module ui/rooms/remote/fade-time
 */

/** @type {ReadonlyArray<{label: string, ms: number}>} */
export const TEMPO = Object.freeze([
  { label: 'Now', ms: 0 },
  { label: '10s', ms: 10_000 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
  { label: '15m', ms: 900_000 },
  { label: '1h', ms: 3_600_000 },
]);

/**
 * @param {number} [initialIndex]
 * @returns {{root: HTMLElement, getOverMs: () => number, getLabel: () => string}}
 */
export function createFadeTimeControl(initialIndex = 0) {
  let index = TEMPO[initialIndex] ? initialIndex : 0;

  const root = document.createElement('div');
  root.className = 'msa-fade-time';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Fade time');

  const buttons = TEMPO.map((tempo, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = tempo.label;
    btn.title = i === 0 ? 'Cut — no fade, changes land instantly' : `Ease over ${tempo.label}`;
    btn.setAttribute('aria-pressed', String(i === index));
    btn.addEventListener('click', () => {
      index = i;
      for (const [j, b] of buttons.entries()) b.setAttribute('aria-pressed', String(j === index));
    });
    root.appendChild(btn);
    return btn;
  });

  return {
    root,
    getOverMs: () => TEMPO[index].ms,
    getLabel: () => TEMPO[index].label,
  };
}
