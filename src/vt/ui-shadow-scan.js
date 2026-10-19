/**
 * ui-shadow-scan.js — THE DOM-READING HALF OF THE UI WINDOW SHADOW, OFF THE
 * FRAME'S CRITICAL PATH.
 *
 * ============================================================================
 * WHY THIS EXISTS (2026-10-14, DevTools "Forced reflow" on a perf trace)
 * ============================================================================
 * `updateUiShadowStamps` (vt-pan-viewer.js) used to read the canvas rect and
 * every open Foundry window's rect from INSIDE the render loop's own
 * requestAnimationFrame callback. `getBoundingClientRect()` is a layout read:
 * if anything has dirtied style or layout earlier in the same frame — and in a
 * live Foundry session something almost always has (chat, the combat tracker,
 * tooltips, other modules' own rAF callbacks) — the browser must flush a full
 * "Recalculate style" + "Layout" RIGHT THERE, synchronously, in the middle of
 * the frame. The trace showed exactly that pair, both attributed to the first
 * read (`canvas.getBoundingClientRect()`), under `runLightAccumulatePass`.
 *
 * Throttling it to every Nth frame (the v5 fix) made it rarer, not cheaper:
 * each scan frame still paid the whole flush, and a flush in the middle of the
 * callback is pure EXTRA work whenever the callback dirties the DOM again
 * afterwards (the heartbeat tail does), because the browser then has to lay
 * out a second time before painting.
 *
 * THE FIX IS WHEN, NOT HOW OFTEN. The read moves to a macrotask queued from the
 * frame (`setTimeout(…, 0)`). A task queued from inside a rAF callback cannot
 * run until the whole rendering update — callbacks, style, layout, paint — has
 * finished, so the layout it reads is already clean and the read is a cached
 * lookup instead of a flush. The frame loop only ever touches plain JS data:
 * it asks for a scan, and applies the newest finished one. The result is one
 * frame staler than before, on top of the existing scan interval — a window
 * drag's shadow trails by a frame, which the throttle already allowed for.
 *
 * `readUiWindowRects` is a PURE READ — no uniform writes, no mapping — so the
 * "which windows count" rule is testable with a fake document, and the mapping
 * to shadow stamps stays in the frame loop beside the look params it needs.
 *
 * @module vt/ui-shadow-scan
 */

/** @typedef {{left: number, top: number, width: number, height: number}} Rect */

/**
 * Every element that is `.application` OR `.app.window-app`, in document
 * order — what `querySelectorAll('.application, .app.window-app')` returned,
 * found through the class index instead.
 *
 * WHY (2026-10-19, measured in a live Foundry v14 page, ~9k elements, Studio
 * open): that selector LIST cost 1.0 ms per call — Chrome walks and matches
 * the whole tree for a list/compound selector — while `.application` alone,
 * or `getElementsByClassName`, cost ~0.05 ms. The layout reads after it were
 * free (the post-frame macrotask already sees clean layout). The scan is now
 * class-index lookups and nothing else; the cost no longer grows with the
 * size of the page (chat logs, journals, the Studio).
 *
 * `getElementsByClassName('app window-app')` requires BOTH classes — exactly
 * the compound `.app.window-app`. The two lists are merged without
 * duplicates and re-sorted into document order only when both are non-empty
 * (legacy windows are rare), since the first {@link MAX_UI_SHADOW_STAMPS}
 * windows in that order are the ones that cast.
 *
 * @param {Document} doc
 * @returns {Element[]}
 */
export function findWindowCandidates(doc) {
  const apps = [...doc.getElementsByClassName('application')];
  const legacy = [...doc.getElementsByClassName('app window-app')];
  if (!legacy.length) return apps;
  if (!apps.length) return legacy;
  const seen = new Set(apps);
  const all = apps.concat(legacy.filter((el) => !seen.has(el)));
  // compareDocumentPosition: bit 4 (FOLLOWING) set → b comes after a.
  return all.sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1));
}

/**
 * Read the canvas rect and every open, framed Foundry window's rect. ApplicationV2
 * `.application` and legacy `.app.window-app` both count, but only when they own
 * a direct-child `.window-header` (a title bar to grab) — that excludes docked UI
 * such as the sidebar and hotbar, which carry `.application` too. Minimized and
 * zero-size windows cast nothing.
 *
 * ⚠️ A LAYOUT READ. Call it from a macrotask (see `createPostFrameScanner`),
 * never from inside the frame's rAF callback.
 *
 * @param {Document} doc
 * @param {{isConnected?: boolean, getBoundingClientRect: () => Rect}|null} canvas
 * @returns {{canvasRect: Rect, windows: Rect[]}|null} `null` when the canvas is
 *   gone (viewer stopped) — there is nothing meaningful to scan against.
 */
export function readUiWindowRects(doc, canvas) {
  if (!canvas || canvas.isConnected === false) return null;
  const c = canvas.getBoundingClientRect();
  const canvasRect = { left: c.left, top: c.top, width: c.width, height: c.height };
  /** @type {Rect[]} */
  const windows = [];
  for (const el of findWindowCandidates(doc)) {
    if (!el.querySelector(':scope > .window-header')) continue;
    if (el.classList.contains('minimized')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    windows.push({ left: r.left, top: r.top, width: r.width, height: r.height });
  }
  return { canvasRect, windows };
}

/**
 * Run `read` in a macrotask AFTER the current frame's rendering update, and
 * hand the newest result back to the frame loop on request.
 *
 * `request()` is idempotent while a read is queued, so a slow task can never
 * stack reads; `take()` returns each finished read ONCE (then `null`), so the
 * frame loop applies a result exactly one time rather than re-mapping a stale
 * one every frame.
 *
 * @template T
 * @param {{read: () => T|null,
 *   schedule?: (fn: () => void) => unknown,
 *   cancel?: (handle: unknown) => void}} args - `schedule`/`cancel` default to
 *   `setTimeout(fn, 0)`/`clearTimeout`; injectable so Node can drive it by hand.
 * @returns {{request: () => void, take: () => T|null, discard: () => void}}
 */
export function createPostFrameScanner({
  read,
  schedule = (fn) => setTimeout(fn, 0),
  cancel = (handle) => clearTimeout(/** @type {any} */ (handle)),
}) {
  /** @type {unknown} */
  let handle = null;
  /** @type {T|null} */
  let result = null;
  return {
    /** Queue a read unless one is already queued. */
    request() {
      if (handle !== null) return;
      handle = schedule(() => {
        handle = null;
        const scan = read();
        // A `null` read (canvas gone) keeps whatever finished result is still
        // waiting rather than erasing it.
        if (scan) result = scan;
      });
    },
    /** The newest finished read, once. */
    take() {
      const scan = result;
      result = null;
      return scan;
    },
    /** Drop a queued read and any unconsumed result — the feature went off, or the viewer stopped. */
    discard() {
      if (handle !== null) cancel(handle);
      handle = null;
      result = null;
    },
  };
}
