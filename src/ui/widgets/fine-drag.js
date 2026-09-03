/**
 * ui/widgets/fine-drag.js — precision adjustment for a native `<input
 * type="range">` (mythica-machina-press#491: V2's Tweakpane UI had a slider
 * drag handle that could nudge a value in much smaller increments than a
 * normal drag; the current plain-DOM widgets had no equivalent).
 *
 * A range input's own pointer→value mapping during a normal drag is owned
 * entirely by the browser (track position maps straight to a value between
 * `min`/`max`, snapped to `step`) — there is no attribute or event that lets
 * script divide that sensitivity. That's fine for a tight range, but several
 * ROH dials were deliberately widened to spans like 0..200 while live-tuning
 * fire (mythica-machina-press#485) specifically so an author could "find the
 * values" — on a ~150px-wide slider that is over a unit of value per pixel
 * of mouse movement, well past the precision needed to sit near a default
 * like 1.5.
 *
 * Two ways in, same session underneath (`runFineDragSession`):
 *  1. `attachFineDrag` — hold Shift and drag the slider itself.
 *  2. `createFineDragHandle` — a small always-on grip rendered beside the
 *     slider (round 2, author: *"add a 'handle'... similar to how Tweakpane
 *     works"*), no modifier needed — every press on IT starts a fine drag.
 * Both take the drag over from the browser and compute the new value from
 * cumulative pointer movement at a fraction of a normal drag's granularity
 * instead of the browser's own absolute track-position mapping, then
 * dispatch real `input`/`change` events so the surrounding row's own
 * readout/commit listeners work completely unchanged.
 *
 * An ordinary drag on the slider itself (no Shift) is left completely
 * untouched — still the browser's own native jump-to-position-and-snap-to-
 * step behaviour, exactly as before this file existed. There is no
 * per-effect configuration to declare: sensitivity is derived from the
 * input's OWN `step` (`step / FINE_STEP_DIVISOR` value per pixel), so a
 * widely-ranged dial and a tightly-ranged one both get "finer than a normal
 * drag can reach" for free, with nothing new needed in
 * `core/params-schema.js`.
 *
 * @module ui/widgets/fine-drag
 */

/** Each pixel of a fine drag moves the value by `step / this` — an order of
 * magnitude finer than a normal drag's own step-snapped granularity. */
export const FINE_STEP_DIVISOR = 10;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The pure half: given where a fine drag started and how far the pointer
 * has moved since (already sign-corrected for axis — positive always means
 * "more"), what value the slider should show right now. Node-testable and
 * exported so the arithmetic is verified without a browser (CONVENTIONS.md
 * §4) — the DOM-wiring half below isn't.
 * @param {{startValue: number, deltaPx: number, min: number, max: number, step: number}} args
 *   `step` need not be finite/positive — a param without one (or a
 *   momentarily-empty `input.step`) falls back to a 100th of the range.
 * @returns {number} clamped to `[min, max]`, rounded to 6 decimals to keep
 *   float noise (an `0.1 + 0.2`-style artifact) out of the readout and the
 *   eventual committed value.
 */
export function computeFineDragValue({ startValue, deltaPx, min, max, step }) {
  const safeStep = Number.isFinite(step) && step > 0 ? step : (max - min) / 100 || 1;
  const perPixel = safeStep / FINE_STEP_DIVISOR;
  const next = clamp(startValue + deltaPx * perPixel, min, max);
  return Math.round(next * 1e6) / 1e6;
}

/**
 * Wire a full press→drag→release fine-drag session onto `captureEl`, driving
 * `input`'s value. Shared by both entry points below — `attachFineDrag`
 * listens on the slider itself and gates on Shift; `createFineDragHandle`
 * listens on its own dedicated grip and has nothing to gate (every press on
 * a handle IS the drag). Re-reads `input`'s `min`/`max`/`step` live on every
 * move (rather than capturing them once), so it stays correct even if a
 * caller rebuilds the row with new bounds mid-session.
 * @param {HTMLElement} captureEl - receives the pointer events and the capture.
 * @param {HTMLInputElement} input - the range input whose value this drives.
 * @param {{axis: 'x' | 'y', shouldEngage: (e: PointerEvent) => boolean}} opts
 */
function runFineDragSession(captureEl, input, { axis, shouldEngage }) {
  // Screen Y grows downward; negating it makes "up" a positive delta, which
  // is what "more" means on the rotated vertical fader (see `axis` on the
  // public functions below).
  const pos = axis === 'y' ? (e) => -e.clientY : (e) => e.clientX;

  let dragging = false;
  let startPos = 0;
  let startValue = 0;

  captureEl.addEventListener('pointerdown', (e) => {
    if (!shouldEngage(e)) return;
    const min = Number(input.min);
    const max = Number(input.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    dragging = true;
    startPos = pos(e);
    startValue = clamp(Number(input.value), min, max);
    try {
      captureEl.setPointerCapture(e.pointerId);
    } catch (_) {
      /* no capture: a fine-drag that leaves the track/handle just stops
         tracking, the same degraded-not-wrong fallback the compass dial
         above (param-control.js#buildCompassRow) uses */
    }
    // Stop the browser's own jump-to-click-position from firing first (only
    // matters when captureEl IS the input) — the whole point is to nudge
    // from the CURRENT value, not the pointer's.
    e.preventDefault();
    input.focus({ preventScroll: true });
  });

  captureEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    input.value = String(
      computeFineDragValue({
        startValue,
        deltaPx: pos(e) - startPos,
        min: Number(input.min),
        max: Number(input.max),
        step: Number(input.step),
      })
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      captureEl.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* already released — not worth surfacing */
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  captureEl.addEventListener('pointerup', finish);
  captureEl.addEventListener('pointercancel', finish);
}

/**
 * Wire Shift-drag precision adjustment onto a `<input type="range">` that
 * already has `min`/`max`/`step`/`value` set.
 * @param {HTMLInputElement} input
 * @param {{ integer?: boolean, axis?: 'x' | 'y' }} [opts]
 *   `integer` — pass `true` for an int-typed param and this is a no-op: an
 *   integer's declared step is already 1, and there is no finer value an int
 *   can hold, so there is nothing for a fine drag to add.
 *   `axis` — which pointer coordinate reads as "more". Defaults to `'x'`
 *   (every normal horizontal slider). `vertical-fader.js` passes `'y'`: its
 *   `<input>` is a real horizontal range rotated with `writing-mode` +
 *   `direction: rtl` so the TOP of the track is the max — a fine drag must
 *   read "up" as the same direction that means "more" there too.
 */
export function attachFineDrag(input, { integer = false, axis = 'x' } = {}) {
  if (integer) return;
  runFineDragSession(input, input, { axis, shouldEngage: (e) => e.shiftKey });
}

const HANDLE_STYLE_ID = 'msa-fine-drag-handle-style';

/** Injected once — CSS `:hover`/`:active` reach the handle's own line in a
 * way a plain inline style object cannot (`scale-control.js`'s own
 * `injectStyle` precedent). */
function injectHandleStyle() {
  if (document.getElementById(HANDLE_STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = HANDLE_STYLE_ID;
  el.textContent = `
.msa-fine-drag-handle{display:flex; align-items:center; justify-content:center; flex:0 0 auto; pointer-events:auto; touch-action:none}
.msa-fine-drag-handle .msa-fine-drag-handle-line{background:var(--ink1, #8fa3c4); border-radius:1px; opacity:.55}
.msa-fine-drag-handle:hover .msa-fine-drag-handle-line,
.msa-fine-drag-handle:active .msa-fine-drag-handle-line{background:var(--shine, rgb(143,214,255)); opacity:1}
`.trim();
  document.head.appendChild(el);
}

/**
 * A small always-on grip an author can grab directly for precision
 * adjustment — no Shift needed, every press on it starts a fine drag
 * (Tweakpane's own convention, author's ask 2026-09-03: *"add a 'handle' -
 * basically a vertical line to the right of all sliders"*). A thin line
 * drawn PERPENDICULAR to the drag axis, matching how the slider it sits
 * beside is oriented: a vertical bar you drag left/right next to a normal
 * horizontal slider, a horizontal bar you drag up/down beneath a vertical
 * fader.
 * @param {HTMLInputElement} input - the range input this handle drives.
 * @param {{ integer?: boolean, axis?: 'x' | 'y' }} [opts] - same meaning as
 *   {@link attachFineDrag}.
 * @returns {HTMLElement | null} `null` for an int-typed param — there is
 *   nothing finer than its own step of 1 for a handle to offer, so no
 *   element is created rather than rendering a grip that would do nothing.
 */
export function createFineDragHandle(input, { integer = false, axis = 'x' } = {}) {
  if (integer) return null;
  injectHandleStyle();

  const handle = document.createElement('div');
  handle.className = 'msa-fine-drag-handle';
  handle.title = 'Drag for fine adjustment (same as holding Shift on the slider)';
  Object.assign(handle.style, {
    width: axis === 'y' ? '18px' : '10px',
    height: axis === 'y' ? '10px' : '18px',
    cursor: axis === 'y' ? 'ns-resize' : 'ew-resize',
  });

  const line = document.createElement('div');
  line.className = 'msa-fine-drag-handle-line';
  Object.assign(line.style, axis === 'y' ? { width: '14px', height: '2px' } : { width: '2px', height: '14px' });
  handle.appendChild(line);

  runFineDragSession(handle, input, { axis, shouldEngage: () => true });
  return handle;
}
