/**
 * ui/widgets/draggable.js — pointer-drag a room by its own header, ported
 * verbatim from the mock's own `makeDraggable()` (2026-08-18 fix; author
 * report: "I can't drag the header around to move it"). One implementation,
 * shared by all three rooms (Remote/Studio/Player) rather than three copies
 * that could drift — Studio's own `.room-head` already carried the mock's
 * `cursor:grab`/`:active{cursor:grabbing}` CSS with no listener behind it
 * (looked draggable, silently did nothing on drag — the exact "looks live,
 * does nothing" shape this project's Law 5 exists to catch), found while
 * building this for the Remote.
 *
 * Viewport clamping (2026-09-07, Remote position-memory work) now also runs
 * on window `resize`, not just during the drag itself — a panel dragged
 * near an edge used to just sit past it once the browser/game window shrank,
 * reachable again only by growing the window back. This only ever touches a
 * panel that has actually been moved onto an explicit `left`/`top` (see
 * `positioned` below); a panel still sitting on its CSS `right`/`bottom`
 * default is already safe, since that anchor and the room's own
 * `max-width`/`max-height` reflow with the viewport on their own.
 *
 * @module ui/widgets/draggable
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Wires pointer-drag on `handle`, moving `panel` (switches it from whatever
 * `right`/`bottom` anchor it shipped with to `left`/`top`, clamped to the
 * viewport). Ignores pointerdown on the handle's OWN interactive children
 * (`closest('button,select,input,label')`) so header controls (minimize,
 * close, camera-path, etc.) stay clickable — a draggable region that
 * swallowed its own buttons' clicks would be a worse regression than no
 * drag at all.
 * @param {HTMLElement} handle
 * @param {HTMLElement} panel
 * @param {{storageKey?: string,
 *   getDefaultPosition?: (rect: DOMRect) => ({left: number, top: number}|null|undefined)}} [opts]
 *   `storageKey` — when given, a position the user drags to is remembered in
 *   `localStorage` under this key (mirrors ui/widgets/scale-control.js's own
 *   per-viewer, resets-only-if-you-clear-your-browser persistence — no
 *   `game.settings` ceremony for a value nobody but this browser needs) and
 *   restored on the next `ensurePositioned()` call. `getDefaultPosition` —
 *   consulted once, only when there is no stored position yet, with the
 *   panel's own already-rendered `getBoundingClientRect()`; return
 *   `{left, top}` viewport pixels to place it there instead of its CSS
 *   default, or a falsy value to leave the CSS default alone.
 * @returns {{ensurePositioned: () => void}} `ensurePositioned` applies the
 *   stored or default placement the first time it's called — call it right
 *   after un-hiding the panel, so its rect is real — and just re-clamps the
 *   current position into the (possibly-resized) viewport on every call
 *   after that, so it's safe to call on every `open()`.
 */
export function makeDraggable(handle, panel, opts = {}) {
  const { storageKey, getDefaultPosition } = opts;
  let sx, sy, sl, st;
  let on = false;
  let moved = false;
  let positioned = false;

  function readStored() {
    if (!storageKey) return null;
    try {
      const raw = window.localStorage?.getItem(storageKey);
      if (!raw) return null;
      const pos = JSON.parse(raw);
      return Number.isFinite(pos?.left) && Number.isFinite(pos?.top) ? pos : null;
    } catch (_) {
      return null; // private browsing / storage blocked / corrupt value — fall through to the default
    }
  }

  function writeStored(pos) {
    if (!storageKey) return;
    try {
      window.localStorage?.setItem(storageKey, JSON.stringify(pos));
    } catch (_) {
      // best-effort — dragging still works for this page load either way
    }
  }

  /** The one place that ever writes `panel.style.left/top` — drag, restore,
   * and resize-reclamp all funnel through this so none of them can disagree
   * about how the clamp is done. */
  function applyPosition(left, top) {
    positioned = true;
    const r = panel.getBoundingClientRect();
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = clamp(left, 0, Math.max(0, window.innerWidth - r.width)) + 'px';
    panel.style.top = clamp(top, 0, Math.max(0, window.innerHeight - r.height)) + 'px';
  }

  function ensurePositioned() {
    if (positioned) {
      applyPosition(parseFloat(panel.style.left) || 0, parseFloat(panel.style.top) || 0);
      return;
    }
    const stored = readStored();
    if (stored) {
      applyPosition(stored.left, stored.top);
      return;
    }
    const fallback = getDefaultPosition?.(panel.getBoundingClientRect());
    if (fallback) applyPosition(fallback.left, fallback.top);
  }

  window.addEventListener('resize', () => {
    if (positioned && !panel.hidden) applyPosition(parseFloat(panel.style.left) || 0, parseFloat(panel.style.top) || 0);
  });

  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button,select,input,label')) return;
    on = true;
    moved = false;
    handle.setPointerCapture(e.pointerId);
    const r = panel.getBoundingClientRect();
    sx = e.clientX;
    sy = e.clientY;
    sl = r.left;
    st = r.top;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });
  handle.addEventListener('pointermove', (e) => {
    if (!on) return;
    moved = true;
    applyPosition(sl + e.clientX - sx, st + e.clientY - sy);
  });
  handle.addEventListener('pointerup', () => {
    on = false;
    if (moved) writeStored({ left: parseFloat(panel.style.left) || 0, top: parseFloat(panel.style.top) || 0 });
  });

  return { ensurePositioned };
}
