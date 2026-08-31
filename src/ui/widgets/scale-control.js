/**
 * ui/widgets/scale-control.js — a small "−/+" strip that scales an entire
 * room up or down (2026-08-27, author live-testing round: "a scaling button
 * on the side of the UI which allows the entire UI to become bigger or
 * smaller... generally helpful for people worried about screen real
 * estate").
 *
 * Pure `transform: scale()` on the room's own root element — this does not
 * touch layout at all (the room's `top`/`right`-anchored box keeps its
 * un-scaled position for CSS purposes; the transform only changes what
 * paints, pivoting around `transform-origin`), and pointer events hit-test
 * correctly against the scaled visual result with no extra JS. A room that
 * is itself `position:fixed`, transformed, becomes the containing block for
 * any `position:fixed` DESCENDANT — a real caveat this file's own callers
 * must be clear of; the Remote's own popovers (wind/tile-motion/camera-path)
 * are unaffected because they are separate top-level elements appended to
 * `document.body`, never children of the room this scales.
 *
 * ⚠️ OUTSIDE THE ROOM, NOT INSET (round 2, author: "the +/- UI is
 * overlapping other parts of the ui... moved to the left till it sits on
 * the outside of the panel"). Round 1 docked this a few px INSIDE the left
 * edge, floating over body content — the honest reason at the time was that
 * every room shell's own root ALSO carries `overflow:hidden` (to clip
 * head/body/foot's own square corners to the room's rounded outer ones),
 * which clips an escaping absolutely-positioned child exactly as hard as
 * anything else. That shape visibly collided with the astrolabe's own BL
 * corner cluster. The real fix was in the room shell, not here: `shell.js`
 * now wraps head/rendererRow/body/foot in their own `.msa-remote-card`
 * (which carries the overflow:hidden), leaving the room's own root
 * unclipped — this strip is `room`'s OWN second child now, a sibling of
 * that card, free to render fully outside the card's visible box.
 *
 * Persisted per `storageKey` via `localStorage` — a per-browser display
 * convenience, not a gameplay-affecting value, so this deliberately skips
 * Foundry's own `game.settings` ceremony (no world/client registration, no
 * GM authority question) in favour of the same lightweight, resets-only-if-
 * you-clear-your-browser persistence every other purely-cosmetic per-viewer
 * preference in a normal web app would use.
 *
 * @module ui/widgets/scale-control
 */

const STYLE_ID = 'msa-scale-control-style';
const MIN_SCALE = 0.75;
const MAX_SCALE = 1.5;
const STEP = 0.1;
const DEFAULT_SCALE = 1;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
.msa-scale-strip{position:absolute; top:50%; left:-8px; transform:translate(-100%, -50%);
  display:flex; flex-direction:column; align-items:center; gap:2px; padding:4px;
  background:var(--glass); backdrop-filter:blur(var(--glass-blur)); border:1px solid var(--line);
  border-radius:999px; box-shadow:var(--shadow3); z-index:5; pointer-events:auto}
.msa-scale-strip button{width:22px; height:22px; display:grid; place-items:center; border-radius:50%;
  color:var(--ink1); background:none; border:none; cursor:pointer; pointer-events:auto; font-size:.85rem;
  font-weight:700; line-height:1}
.msa-scale-strip button:hover{background:var(--bg3); color:var(--ink0)}
.msa-scale-strip button:disabled{opacity:.35; cursor:default}
.msa-scale-strip button:disabled:hover{background:none}
.msa-scale-strip .msa-scale-readout{font-size:.6rem; color:var(--ink2); font-weight:600; padding:1px 0; pointer-events:none}
`.trim();
  document.head.appendChild(el);
}

function clampScale(v) {
  return Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, v)) * 100) / 100;
}

function readStored(storageKey) {
  try {
    const raw = window.localStorage?.getItem(storageKey);
    const n = raw === null ? DEFAULT_SCALE : Number(raw);
    return Number.isFinite(n) ? clampScale(n) : DEFAULT_SCALE;
  } catch (_) {
    return DEFAULT_SCALE; // private browsing / storage blocked — scale just resets each load
  }
}

function writeStored(storageKey, v) {
  try {
    window.localStorage?.setItem(storageKey, String(v));
  } catch (_) {
    // best-effort — the control still works for this page load either way
  }
}

/**
 * Mount a scale strip on the LEFT edge of `targetEl`, vertically centred.
 * `targetEl` must be `position:relative`-or-stronger (every room shell here
 * already is, via `position:fixed`) so the strip's own `position:absolute`
 * anchors to it rather than some further ancestor.
 * @param {HTMLElement} targetEl - the room root to scale.
 * @param {{storageKey: string, transformOrigin?: string}} opts
 *   `storageKey` — localStorage key this room's own scale remembers itself
 *   under; give each room mounting this a distinct one. `transformOrigin`
 *   defaults to `'top right'`, matching every room shell's own `top`/`right`
 *   anchoring (Remote/Studio/Player all position via those two edges) so
 *   scaling pivots from the corner the room is actually pinned to, not the
 *   corner CSS defaults to.
 * @returns {{root: HTMLElement, getScale: () => number, setScale: (v: number) => void}}
 */
export function installScaleControl(targetEl, { storageKey, transformOrigin = 'top right' }) {
  injectStyle();

  let scale = readStored(storageKey);

  const strip = document.createElement('div');
  strip.className = 'msa-scale-strip';
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', 'Interface scale');

  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.textContent = '+';
  plusBtn.title = 'Make this interface bigger';

  const readout = document.createElement('span');
  readout.className = 'msa-scale-readout';

  const minusBtn = document.createElement('button');
  minusBtn.type = 'button';
  minusBtn.textContent = '−';
  minusBtn.title = 'Make this interface smaller';

  strip.append(plusBtn, readout, minusBtn);

  function apply() {
    targetEl.style.transformOrigin = transformOrigin;
    targetEl.style.transform = scale === 1 ? '' : `scale(${scale})`;
    readout.textContent = `${Math.round(scale * 100)}%`;
    plusBtn.disabled = scale >= MAX_SCALE;
    minusBtn.disabled = scale <= MIN_SCALE;
  }

  function setScale(v) {
    scale = clampScale(v);
    writeStored(storageKey, scale);
    apply();
  }

  plusBtn.addEventListener('click', () => setScale(scale + STEP));
  minusBtn.addEventListener('click', () => setScale(scale - STEP));

  apply();

  return { root: strip, getScale: () => scale, setScale };
}
