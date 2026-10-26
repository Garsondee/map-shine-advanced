/**
 * @fileoverview foundry/progress-notice.js — tell the table what a floor or scene
 * change is doing, with FOUNDRY'S OWN progress notification (loading audit,
 * 2026-10-25: "use a Foundry notification to let GM and players know that scene
 * change is processing").
 *
 * ============================================================================
 * WHY FOUNDRY'S NOTIFICATION AND NOT AN OVERLAY OF OURS
 * ============================================================================
 * Foundry already shows a "Loading {scene}" progress notification during every
 * redraw (`F:canvas/loader.mjs:305-310`), so a table is used to reading progress
 * there. `ui.notifications.info(message, {progress: true})` returns a handle with
 * `update({pct, message})` and `remove()`; a progress notification has no timer of
 * its own (it stays until it is updated to 100% or removed), at most five show at
 * once, and it is the same widget on the GM's and every player's screen
 * (`F:applications/ui/notifications.mjs:108-142`, `:313`). `ui/floor-transition.js`
 * stays, but only as the CANCEL control: a notification has no buttons.
 *
 * ============================================================================
 * THE PERCENTAGE IS A STEP, NOT A GUESS
 * ============================================================================
 * `ui/floor-transition.js` and `ui/load-progress.js` both refuse to draw a
 * fabricated percentage: "dimensions-fetch and BC-compression are wildly
 * different costs per item", so no single fraction of a prepare is true. Foundry's
 * progress notification needs a `pct`, so it gets the one honest number there is:
 * how far through the STEPS we are (step 2 of 5, plus the fraction of that step's
 * own counted items), and the message says exactly that — "step 2 of 5: compressing
 * art (3/7)". The bar moves in five known strides; the words carry the detail.
 *
 * ============================================================================
 * A FLOOR CHANGE THAT IS INSTANT SHOWS NOTHING
 * ============================================================================
 * Same rule as `ui/floor-transition.js`: nothing appears until the work has run
 * for `SHOW_AFTER_MS`, so a warm change (everything already prepared) does not
 * flicker a notification on every stair.
 *
 * Pure parts (formatting, the step tracker, text escaping) and an INJECTABLE
 * notifier/timer: Node-tested without Foundry.
 *
 * @module foundry/progress-notice
 */

import { createLogger } from '../core/log.js';

const log = createLogger('progress-notice');

/** How long work must run before anything is shown. Same figure as ui/floor-transition.js. */
export const NOTICE_SHOW_AFTER_MS = 250;

/**
 * Escape text for a Foundry notification message. Level and scene names are user
 * data and `ui.notifications` renders HTML, so they never go in raw.
 * @param {unknown} s @returns {string}
 */
export function escapeNoticeText(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/**
 * The steps of a floor prepare, in the order `prepareFloor` runs them
 * (`vt/vt-pan-viewer.js#prepareFloor`). The phase ids are the ones its
 * `onProgress` reports.
 */
export const FLOOR_PREPARE_STEPS = Object.freeze([
  { id: 'items', label: 'reading the art' },
  { id: 'compress', label: 'compressing the art' },
  { id: 'masks', label: 'loading effect masks' },
  { id: 'bakes', label: 'working out light and wind' },
  { id: 'warmup', label: 'warming the shaders' },
]);

/**
 * The steps of a SCENE prepare (`prewarmSceneForSwitch` in boot.js): find the
 * painted masks, seed the PIXI proxies, then compress the art the first view will
 * ask for. Different work from a floor prepare, so a different list.
 */
export const SCENE_PREPARE_STEPS = Object.freeze([
  { id: 'masks', label: 'finding painted masks' },
  { id: 'proxies', label: 'preparing the map art' },
  { id: 'compress', label: 'compressing the art' },
]);

/**
 * Where are we, given the latest `{phase, done, total}` a prepare reported?
 * @param {ReadonlyArray<{id: string, label: string}>} steps
 * @param {{phase?: string, done?: number, total?: number}|null|undefined} progress
 * @returns {{step: number, of: number, label: string, detail: string, pct: number}}
 *   `step` is 1-based; `pct` is 0..1 by the step-plus-fraction rule in the header.
 */
export function describeStep(steps, progress) {
  const of = steps.length;
  const idx = Math.max(
    0,
    steps.findIndex((s) => s.id === progress?.phase)
  );
  const total = Number(progress?.total);
  const done = Number(progress?.done);
  const hasCount = Number.isFinite(total) && total > 1 && Number.isFinite(done);
  const within = hasCount ? Math.min(1, Math.max(0, done / total)) : 0;
  return {
    step: idx + 1,
    of,
    label: steps[idx]?.label ?? '',
    detail: hasCount ? ` (${Math.min(done, total)}/${total})` : '',
    pct: Math.min(1, (idx + within) / of),
  };
}

/**
 * The notification text for one moment of a prepare.
 * @param {{verb?: string, name: string}} subject - e.g. {verb: 'Preparing', name: 'Ground Floor'}
 * @param {ReturnType<typeof describeStep>} d
 * @returns {string} already escaped
 */
export function formatPrepareMessage({ verb = 'Preparing', name }, d) {
  return `${escapeNoticeText(verb)} ${escapeNoticeText(name)} — step ${d.step} of ${d.of}: ${escapeNoticeText(d.label)}${d.detail}`;
}

/**
 * A plain one-off notification (the progress ones above are for work in flight).
 * @param {'info'|'warn'|'error'} level
 * @param {string} message - ALREADY escaped; Foundry renders it as HTML.
 */
export function notifyUser(level, message) {
  try {
    globalThis.ui?.notifications?.[level]?.(message);
  } catch (err) {
    log.error('a notification could not be shown:', err);
  }
}

/**
 * A notification that appears only if the work is not instant, is updated as it
 * goes, and is removed when it ends.
 *
 * @param {object} [deps]
 * @param {() => {info: Function}|null|undefined} [deps.getNotifications] -
 *   defaults to `globalThis.ui?.notifications`.
 * @param {(fn: Function, ms: number) => any} [deps.setTimer]
 * @param {(handle: any) => void} [deps.clearTimer]
 * @param {number} [deps.showAfterMs]
 * @returns {{begin: (message: string) => {update: (message: string, pct: number) => void, end: (finalMessage?: string) => void, isShown: () => boolean}}}
 */
export function createProgressNotice({
  getNotifications = () => globalThis.ui?.notifications,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  showAfterMs = NOTICE_SHOW_AFTER_MS,
} = {}) {
  return {
    begin(initialMessage) {
      let message = initialMessage;
      let pct = 0;
      let shown = null;
      let ended = false;
      const timer = setTimer(() => {
        if (ended) return;
        const n = getNotifications();
        if (!n?.info) return;
        try {
          // console:false — a bar updated this often would otherwise write a
          // console line per update (`notifications.mjs:278,345-349`).
          shown = n.info(message, { progress: true, console: false });
          if (pct > 0) shown?.update?.({ pct, message });
        } catch (err) {
          // A notification must never be the thing that breaks a floor change.
          log.error('progress notification could not be shown:', err);
          shown = null;
        }
      }, showAfterMs);
      return {
        update(nextMessage, nextPct) {
          if (ended) return;
          message = nextMessage;
          pct = Math.min(1, Math.max(0, Number(nextPct) || 0));
          if (shown) {
            try {
              shown.update?.({ pct, message });
            } catch (err) {
              log.error('progress notification update failed:', err);
            }
          }
        },
        end() {
          if (ended) return;
          ended = true;
          clearTimer(timer);
          if (shown) {
            try {
              shown.remove?.();
            } catch (err) {
              log.error('progress notification could not be removed:', err);
            }
            shown = null;
          }
        },
        isShown: () => shown !== null,
      };
    },
  };
}
