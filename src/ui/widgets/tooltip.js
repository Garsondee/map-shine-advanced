/**
 * ui/widgets/tooltip.js — one themed tooltip for every control in the Studio.
 *
 * WHY NOT THE NATIVE `title` TOOLTIP. It ignores the active LANTERN theme, has
 * a long and uncontrollable delay, never wraps sensibly, and — the part that
 * matters most on a toolbar of icon buttons — restarts its full delay for
 * EVERY neighbour you hover. This one waits once, then answers instantly while
 * you sweep along a row of buttons, which makes the whole row feel faster
 * without defeating the delay that stops an accidental hover from popping one.
 *
 * HOW IT STAYS A DROP-IN. The Studio already put a `title` on every control
 * (that is where every tooltip's text lives). Rather than rewrite hundreds of
 * call sites, the first hover/focus of an element INSIDE the configured scope
 * moves its `title` into `data-tip` (so the browser stops drawing its own) and
 * mirrors it to `aria-label` when the element has no other accessible name —
 * an icon-only button whose only name was the `title` stays announced. Code
 * that assigns `.title` again later just gets converted again on the next hover
 * — except code that re-assigns it OFTEN (a speed readout refreshed ten times a
 * second): the native tooltip would reappear between hovers. That code calls
 * {@link setTip}, which writes whichever of the two the element is using now.
 *
 * ONE TOOLTIP, MANY ROOMS. The Studio installed this first, with its own scope;
 * the Remote and the Player room added theirs later. Every `installTooltips`
 * call therefore ADDS its scope to the one live tooltip (see
 * {@link mergeTooltipScopes}) rather than being refused as a repeat — the first
 * version quietly ignored later calls, so a second room's tooltips would have
 * stayed native.
 *
 * Pure halves are exported and tested in Node: {@link computeTooltipPosition}
 * (placement, flip, clamp), {@link createTooltipMachine} (the delay /
 * warm-window / suppress state machine, with injectable timers),
 * {@link mergeTooltipScopes} and {@link setTip}. The DOM wiring below them is
 * verified live in the preview harnesses.
 *
 * ⚠️ NO WALL CLOCK. The structure suite's `time/one-clock` rule forbids reading
 * `performance.now()`/`Date.now()` in `src/ui`; the "recently closed, answer
 * instantly" window is a timer that clears a flag, not a timestamp comparison.
 *
 * @module ui/widgets/tooltip
 */

const STYLE_ID = 'msa-tooltip-style';

/** Wait before the FIRST tooltip appears; short enough to feel attentive,
 * long enough that sweeping the pointer across a toolbar does not strobe. */
export const TOOLTIP_OPEN_DELAY_MS = 450;
/** After a tooltip closes, how long the NEXT one skips both the delay and the
 * animation — the "I'm already scanning this row" window. */
export const TOOLTIP_WARM_MS = 320;

const GAP = 8;
const VIEWPORT_MARGIN = 8;

/** The Studio's own scope — what {@link installTooltips} covers when no scope is given. */
export const DEFAULT_TOOLTIP_SCOPE = '#msa-studio, .msa-studio-pop';

/**
 * Add a selector list to the scopes already covered: split on the commas that
 * are NOT inside parentheses (`:is(a, b)` stays whole), trimmed, blanks dropped,
 * and anything already present skipped — so every room can call
 * `installTooltips` without caring who got there first.
 * @param {readonly string[]} current @param {string} scope
 * @returns {string[]} a new list (the input is not changed).
 */
export function mergeTooltipScopes(current, scope) {
  const out = [...current];
  const parts = [];
  let depth = 0;
  let part = '';
  for (const ch of String(scope ?? '')) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(part);
      part = '';
    } else {
      part += ch;
    }
  }
  parts.push(part);
  for (const raw of parts) {
    const sel = raw.trim();
    if (sel && !out.includes(sel)) out.push(sel);
  }
  return out;
}

/**
 * Change an element's tooltip text from code that runs repeatedly. Once the
 * widget has taken an element over (`title` moved into `data-tip`), writing
 * `title` again would bring the browser's own tooltip back beside the themed one;
 * before that, writing `data-tip` would hide the text on a touch device, where the
 * widget never installs and the native long-press `title` is all there is.
 * @param {{hasAttribute: (name: string) => boolean, dataset: Record<string, string>, title: string}|null|undefined} el
 * @param {string} text
 */
export function setTip(el, text) {
  if (!el) return;
  if (el.hasAttribute('data-tip')) el.dataset.tip = text;
  else el.title = text;
}

/**
 * Where to put a tooltip. Prefers `side` (default: below), flips to the
 * opposite side when it would leave the viewport and the opposite fits, then
 * clamps along the cross axis so it never hangs off a screen edge.
 * @param {{
 *   anchor: {left: number, top: number, right: number, bottom: number},
 *   size: {w: number, h: number},
 *   viewport: {w: number, h: number},
 *   side?: 'auto'|'top'|'bottom'|'left'|'right',
 * }} args
 * @returns {{left: number, top: number, side: 'top'|'bottom'|'left'|'right'}}
 */
export function computeTooltipPosition({ anchor, size, viewport, side = 'auto' }) {
  const { w, h } = size;
  const cx = (anchor.left + anchor.right) / 2;
  const cy = (anchor.top + anchor.bottom) / 2;
  const fits = {
    bottom: anchor.bottom + GAP + h <= viewport.h - VIEWPORT_MARGIN,
    top: anchor.top - GAP - h >= VIEWPORT_MARGIN,
    right: anchor.right + GAP + w <= viewport.w - VIEWPORT_MARGIN,
    left: anchor.left - GAP - w >= VIEWPORT_MARGIN,
  };
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  let chosen = side === 'auto' ? 'bottom' : side;
  if (!fits[chosen] && fits[opposite[chosen]]) chosen = opposite[chosen];

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  let left;
  let top;
  if (chosen === 'top' || chosen === 'bottom') {
    left = clamp(cx - w / 2, VIEWPORT_MARGIN, viewport.w - VIEWPORT_MARGIN - w);
    top = chosen === 'bottom' ? anchor.bottom + GAP : anchor.top - GAP - h;
  } else {
    top = clamp(cy - h / 2, VIEWPORT_MARGIN, viewport.h - VIEWPORT_MARGIN - h);
    left = chosen === 'right' ? anchor.right + GAP : anchor.left - GAP - w;
  }
  return { left: Math.round(left), top: Math.round(top), side: chosen };
}

/**
 * The show/hide state machine, free of the DOM so its timing rules are
 * testable with fake timers.
 *
 *  - first `enter` waits `openDelayMs`, then calls `show(..., {instant:false})`
 *  - while one is showing, `enter` on a NEW target swaps to it at once
 *  - for `warmMs` after a hide, `enter` also skips the wait (`instant:true`)
 *  - `leave` before the delay elapsed just cancels it
 *  - `dismiss` (a press, a scroll, Escape) hides and ignores that target until
 *    the pointer actually leaves it, so a tooltip never reappears under a
 *    slider you are dragging
 * @param {{
 *   show: (target: any, text: string, opts: {instant: boolean, side?: string}) => void,
 *   hide: () => void,
 *   openDelayMs?: number, warmMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (h: any) => void,
 * }} deps
 */
export function createTooltipMachine({
  show,
  hide,
  openDelayMs = TOOLTIP_OPEN_DELAY_MS,
  warmMs = TOOLTIP_WARM_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
}) {
  let shown = null;
  let pending = null;
  let pendingTimer = null;
  let warm = false;
  let warmTimer = null;
  let suppressed = null;

  const cancelPending = () => {
    if (pendingTimer !== null) clearTimer(pendingTimer);
    pendingTimer = null;
    pending = null;
  };
  const startWarm = () => {
    warm = true;
    if (warmTimer !== null) clearTimer(warmTimer);
    warmTimer = setTimer(() => {
      warm = false;
      warmTimer = null;
    }, warmMs);
  };
  const hideNow = () => {
    if (shown === null) return;
    shown = null;
    hide();
    startWarm();
  };

  return {
    /** @param {any} target @param {string} text @param {string} [side] */
    enter(target, text, side) {
      if (!text || target === suppressed || target === shown) return;
      if (target === pending) return;
      cancelPending();
      if (shown !== null || warm) {
        shown = target;
        show(target, text, { instant: true, side });
        return;
      }
      pending = target;
      pendingTimer = setTimer(() => {
        pendingTimer = null;
        pending = null;
        shown = target;
        show(target, text, { instant: false, side });
      }, openDelayMs);
    },
    /** @param {any} target */
    leave(target) {
      if (suppressed === target) suppressed = null;
      if (pending === target) cancelPending();
      else if (shown === target) hideNow();
    },
    /** Hide and ignore `target` until the pointer leaves it. @param {any} [target] */
    dismiss(target) {
      cancelPending();
      if (target !== undefined) suppressed = target;
      hideNow();
    },
    /** Hide everything and forget all state (scroll, Escape, teardown). */
    reset() {
      cancelPending();
      suppressed = null;
      hideNow();
    },
    isShowing: () => shown !== null,
    isWarm: () => warm,
  };
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
.msa-tip{position:fixed; left:0; top:0; z-index:600; max-width:280px; padding:6px 9px;
  border-radius:7px; background:var(--bg3); color:var(--ink0); border:1px solid var(--line-strong);
  box-shadow:var(--shadow2); font:11px/1.4 var(--font, system-ui, sans-serif); pointer-events:none;
  white-space:normal; overflow-wrap:anywhere;
  opacity:0; visibility:hidden; transform:scale(.96);
  transition:opacity 125ms var(--ease-out, ease-out), transform 125ms var(--ease-out, ease-out), visibility 0s linear 125ms}
.msa-tip[data-open]{opacity:1; visibility:visible; transform:none;
  transition:opacity 125ms var(--ease-out, ease-out), transform 125ms var(--ease-out, ease-out), visibility 0s}
.msa-tip[data-instant], .msa-tip[data-instant][data-open]{transition-duration:0ms; transition-delay:0ms}
.msa-tip[data-side="top"]{transform-origin:50% 100%}
.msa-tip[data-side="bottom"]{transform-origin:50% 0}
.msa-tip[data-side="left"]{transform-origin:100% 50%}
.msa-tip[data-side="right"]{transform-origin:0 50%}
`.trim();
  document.head.appendChild(el);
}

/** @type {{destroy: () => void}|null} the one live tooltip, once installed */
let liveHandle = null;
/** The selector lists every room has asked for so far (see {@link mergeTooltipScopes}). */
let scopes = [];
/** @type {HTMLElement|null} */
let liveTip = null;

/**
 * Turn on themed tooltips for everything inside `scope`. Safe to call from every
 * room: the first call installs the tooltip, every later call ADDS its `scope` to
 * it and returns the same handle. A no-op on touch-first devices (no hover),
 * where the native long-press `title` stays.
 * @param {{scope?: string, openDelayMs?: number, warmMs?: number}} [opts]
 *   `scope` — a CSS selector list; only elements inside a match are handled.
 *   `openDelayMs`/`warmMs` are read by the FIRST call only.
 * @returns {{destroy: () => void}|null} null when not installed (touch-first device).
 */
export function installTooltips({ scope = DEFAULT_TOOLTIP_SCOPE, openDelayMs, warmMs } = {}) {
  if (typeof document === 'undefined') return null;
  if (typeof matchMedia === 'function' && !matchMedia('(hover: hover) and (pointer: fine)').matches) return null;
  scopes = mergeTooltipScopes(scopes, scope);
  if (liveHandle) {
    // The tooltip element publishes what it covers — handy in devtools, and it is
    // how tools/preview-shared/control-audit.js knows a `title` is already handled.
    if (liveTip) liveTip.dataset.scope = scopes.join(', ');
    return liveHandle;
  }
  injectStyle();

  const tip = document.createElement('div');
  tip.className = 'msa-tip';
  tip.setAttribute('role', 'tooltip');
  tip.id = 'msa-tooltip';
  tip.dataset.scope = scopes.join(', ');
  document.body.appendChild(tip);
  liveTip = tip;

  /** @type {Element|null} */
  let describing = null;

  const machine = createTooltipMachine({
    openDelayMs,
    warmMs,
    show(target, text, { instant, side }) {
      if (!(target instanceof Element) || !target.isConnected) return;
      tip.textContent = text;
      // Measure first, then place — the element is `visibility:hidden` but laid
      // out, so its real wrapped size is available before it is ever visible.
      // Back to 0,0 before measuring: a fixed box shrink-wraps against the
      // room LEFT of its current offset to the viewport edge, so a tooltip last
      // shown near the right edge would measure (and wrap) far too narrow.
      tip.style.left = '0px';
      tip.style.top = '0px';
      const size = { w: tip.offsetWidth, h: tip.offsetHeight };
      const r = target.getBoundingClientRect();
      const pos = computeTooltipPosition({
        anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
        size,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        side: side ?? 'auto',
      });
      tip.style.left = `${pos.left}px`;
      tip.style.top = `${pos.top}px`;
      tip.dataset.side = pos.side;
      if (instant) tip.dataset.instant = '';
      else delete tip.dataset.instant;
      tip.dataset.open = '';
      if (describing && describing !== target) describing.removeAttribute('aria-describedby');
      target.setAttribute('aria-describedby', tip.id);
      describing = target;
    },
    hide() {
      delete tip.dataset.open;
      if (describing) {
        describing.removeAttribute('aria-describedby');
        describing = null;
      }
    },
  });

  /** The element a tooltip belongs to, and its text — or null. Moves `title`
   * to `data-tip` on first sight (see the module doc). */
  function tipTarget(node) {
    if (!(node instanceof Element)) return null;
    const el = node.closest('[title],[data-tip]');
    if (!el || !node.closest(scopes.join(', '))) return null;
    const title = el.getAttribute('title');
    if (title) {
      el.dataset.tip = title;
      el.removeAttribute('title');
      if (!el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', title);
    }
    const text = el.dataset.tip;
    if (!text) return null;
    // `data-tip-truncated`: the tooltip only exists to reveal text that was cut
    // off with an ellipsis, so say nothing when the text is all already visible.
    if (el.hasAttribute('data-tip-truncated') && el.scrollWidth <= el.clientWidth + 1) return null;
    return { el, text };
  }

  const onOver = (e) => {
    if (describing && !describing.isConnected) machine.reset();
    const hit = tipTarget(e.target);
    if (hit) machine.enter(hit.el, hit.text, hit.el.dataset.tipSide);
  };
  const onOut = (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    if (!el) return;
    if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
    machine.leave(el);
  };
  const onFocusIn = (e) => {
    // Keyboard focus only — a mouse click focuses a button too, and that
    // press already dismissed the tooltip on purpose.
    if (!(e.target instanceof Element) || !e.target.matches(':focus-visible')) return;
    const hit = tipTarget(e.target);
    if (hit) machine.enter(hit.el, hit.text, hit.el.dataset.tipSide);
  };
  const onFocusOut = (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    if (el) machine.leave(el);
  };
  const onDown = (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    machine.dismiss(el ?? undefined);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') machine.reset();
  };
  const onScroll = () => machine.reset();

  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', onScroll, true);

  liveHandle = {
    destroy() {
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerout', onOut, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      machine.reset();
      tip.remove();
      liveHandle = null;
      liveTip = null;
      scopes = [];
    },
  };
  return liveHandle;
}
