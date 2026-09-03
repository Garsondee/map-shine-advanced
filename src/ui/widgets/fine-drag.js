/**
 * ui/widgets/fine-drag.js — Shift-drag precision adjustment for a native
 * `<input type="range">` (mythica-machina-press#491: V2's Tweakpane UI had
 * a slider drag handle that could nudge a value in much smaller increments
 * than a normal drag; the current plain-DOM widgets had no equivalent).
 *
 * A range input's own pointer→value mapping during a normal drag is owned
 * entirely by the browser (track position maps straight to a value between
 * `min`/`max`, snapped to `step`) — there is no attribute or event that lets
 * script divide that sensitivity. That's fine for a tight range, but several
 * ROH dials were deliberately widened to spans like 0..200 while live-tuning
 * fire (mythica-machina-press#485) specifically so an author could "find the
 * values" — on a ~150px-wide slider that is over a unit of value per pixel
 * of mouse movement, well past the precision needed to sit near a default
 * like 1.5. This module takes the drag over ONLY while Shift is held at
 * `pointerdown`, computing the new value from cumulative pointer movement at
 * a fraction of a normal drag's granularity instead of the browser's own
 * absolute track-position mapping.
 *
 * Deliberately narrow: an ordinary drag (no Shift, the overwhelming
 * majority) is left completely untouched — still the browser's own native
 * jump-to-position-and-snap-to-step behaviour, exactly as before this file
 * existed. There is no per-effect configuration to declare: sensitivity is
 * derived from the input's OWN `step` (`step / FINE_STEP_DIVISOR` value per
 * pixel), so a widely-ranged dial and a tightly-ranged one both get "finer
 * than a normal drag can reach" for free, with nothing new needed in
 * `core/params-schema.js`.
 *
 * @module ui/widgets/fine-drag
 */

/** Each pixel of a Shift-drag moves the value by `step / this` — an order of
 * magnitude finer than a normal drag's own step-snapped granularity. */
export const FINE_STEP_DIVISOR = 10;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The pure half: given where a Shift-drag started and how far the pointer
 * has moved since (already sign-corrected for axis — positive always means
 * "more"), what value the slider should show right now. Node-testable and
 * exported so the arithmetic is verified without a browser (CONVENTIONS.md
 * §4) — `attachFineDrag` below is the thin DOM-wiring half that isn't.
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
 * Wire Shift-drag precision adjustment onto a `<input type="range">` that
 * already has `min`/`max`/`step`/`value` set. Re-reads those attributes live
 * on every drag (rather than capturing them once), so it stays correct even
 * if a caller rebuilds the row with new bounds.
 *
 * @param {HTMLInputElement} input
 * @param {{ integer?: boolean, axis?: 'x' | 'y' }} [opts]
 *   `integer` — pass `true` for an int-typed param and this is a no-op: an
 *   integer's declared step is already 1, and there is no finer value an int
 *   can hold, so there is nothing for Shift-drag to add.
 *   `axis` — which pointer coordinate reads as "more". Defaults to `'x'`
 *   (every normal horizontal slider). `vertical-fader.js` passes `'y'`: its
 *   `<input>` is a real horizontal range rotated with `writing-mode` +
 *   `direction: rtl` so the TOP of the track is the max — Shift-drag must
 *   read "up" as the same direction that means "more" there too.
 */
export function attachFineDrag(input, { integer = false, axis = 'x' } = {}) {
  if (integer) return;

  // Screen Y grows downward; negating it makes "up" a positive delta, which
  // is what "more" means on the rotated vertical fader (see `axis` above).
  const pos = axis === 'y' ? (e) => -e.clientY : (e) => e.clientX;

  let dragging = false;
  let startPos = 0;
  let startValue = 0;

  input.addEventListener('pointerdown', (e) => {
    // Anything other than a Shift-held press is a normal drag — leave the
    // browser's own native handling completely alone.
    if (!e.shiftKey) return;
    const min = Number(input.min);
    const max = Number(input.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    dragging = true;
    startPos = pos(e);
    startValue = clamp(Number(input.value), min, max);
    try {
      input.setPointerCapture(e.pointerId);
    } catch (_) {
      /* no capture: a fine-drag that leaves the track just stops tracking,
         the same degraded-not-wrong fallback the compass dial uses above */
    }
    // Stop the browser's own jump-to-click-position from firing first — the
    // whole point is to nudge from the CURRENT value, not the pointer's.
    e.preventDefault();
    input.focus({ preventScroll: true });
  });

  input.addEventListener('pointermove', (e) => {
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
      input.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* already released — not worth surfacing */
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  input.addEventListener('pointerup', finish);
  input.addEventListener('pointercancel', finish);
}
