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
 */
export function makeDraggable(handle, panel) {
  let sx, sy, sl, st;
  let on = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button,select,input,label')) return;
    on = true;
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
    const r = panel.getBoundingClientRect();
    panel.style.left = clamp(sl + e.clientX - sx, 0, window.innerWidth - r.width) + 'px';
    panel.style.top = clamp(st + e.clientY - sy, 0, window.innerHeight - r.height) + 'px';
  });
  handle.addEventListener('pointerup', () => {
    on = false;
  });
}
