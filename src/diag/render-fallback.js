/**
 * @fileoverview diag/render-fallback.js — THE SAFETY SLIDE (its last rung, which
 * is the only one that exists yet).
 *
 * When MSA's renderer cannot run, hand rendering back to Foundry's own canvas so
 * the player keeps a working session — and say so loudly enough that nobody can
 * mistake "Foundry is drawing this" for "MSA is drawing this".
 *
 * ## The author's rule, which outranks the visuals
 *
 * Keyhole.md §4.3 / §9 risk 6: the target end-state is **WebGPU → WebGL2 → native
 * Foundry PIXI**, attempted in that order, *"so a player whose hardware can't
 * sustain Keyhole's best effort is never the reason a session stalls or a browser
 * crashes mid-game."* Author's framing, verbatim: *"This isn't scope creep, this
 * is about keeping the reliability/safety of running the module paramount over
 * the visuals."*
 *
 * ## The doctrine distinction, which is easy to get wrong (it was, here)
 *
 * §0 doctrine #1 forbids *"a fallback that routes through legacy code"*. What it
 * forbids is **silently patching a missing V3 FEATURE with V2's implementation
 * mid-build**, so unbuilt work looks finished. A total renderer failure is the
 * opposite shape: a conscious, top-level, WHOLE-SYSTEM mode change that never
 * substitutes for unbuilt Keyhole capability — §4.3 says so in as many words.
 * Refusing to slide, and showing the player an error wall instead, satisfies the
 * doctrine on a technicality and fails the product on the thing the author
 * actually ranked first.
 *
 * ## What was really broken — worse than "the slide isn't built yet"
 *
 * `vt-pan-viewer.js` appends its canvas EARLY — before the WebGL renderer is even
 * constructed — and that canvas carries `background:#000`. So a Three.js/WebGL
 * failure left an opaque BLACK canvas sitting on top of Foundry's own, perfectly
 * healthy, canvas. The slide wasn't merely absent: **the existing code actively
 * blocked it**, turning a recoverable failure into an unusable session. Tearing
 * that canvas down is most of the fix.
 *
 * ## Loud, but physically incapable of interfering
 *
 * The notice is `pointer-events: none`, so it cannot swallow a click, cover a
 * control, or interrupt play — a permanent marker, not a modal. It is
 * deliberately NOT dismissible: a dismissible warning that says "you are not
 * seeing what you think you are seeing" is one you will miss precisely when it
 * matters. A `ui.notifications.error` fires alongside it because the
 * notification draws the eye and the banner is what persists.
 *
 * @module diag/render-fallback
 */

const NOTICE_ID = 'msa-render-fallback-notice';

/** @type {{active: boolean, reason: string|null, detail: string|null, at: string|null}} */
const state = { active: false, reason: null, detail: null, at: null };

/**
 * Where the notice mounts. Mirrors `vt-pan-viewer.js#resolveMountHost` rather
 * than importing it — `diag/` must not depend on `vt/`, and a failure reporter
 * that breaks when the thing it reports on breaks is useless.
 * @returns {HTMLElement}
 */
function resolveHost() {
  const board = typeof document !== 'undefined' ? document.getElementById('board') : null;
  return board?.parentElement ?? document.body;
}

/**
 * SLIDE TO FOUNDRY: stop occluding Foundry's canvas so the player keeps a
 * working session, and post a permanent notice that this happened.
 *
 * Removing the canvas is the load-bearing half. MSA's canvas exists only to
 * OCCLUDE Foundry's; an occluding canvas that is no longer drawing is just a
 * black rectangle over a working game.
 *
 * @param {object} args
 * @param {string} args.reason - one line, player-readable: what went wrong.
 * @param {string} [args.detail] - the real error text/stack, for a pasted report.
 * @param {HTMLCanvasElement|null} [args.canvas] - MSA's canvas, to tear down.
 * @returns {{fellBack: true, reason: string}}
 */
export function engageFoundryFallback({ reason, detail, canvas }) {
  // 1. THE ACTUAL FALLBACK: stop occluding Foundry.
  try {
    canvas?.remove();
  } catch (_) {
    // Never let the fallback path throw — it runs when things are already bad.
  }

  state.active = true;
  state.reason = reason;
  state.detail = detail ?? null;
  state.at = new Date().toISOString();
  console.error(`[msa] renderer unavailable — falling back to Foundry's own rendering: ${reason}`, detail ?? '');

  // 2. Say so, permanently and unmissably, without being able to interfere.
  try {
    document.getElementById(NOTICE_ID)?.remove();
    const el = document.createElement('div');
    el.id = NOTICE_ID;
    Object.assign(el.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '70', // above Foundry's UI (60) so it is always visible; below the debug panel (90)
      pointerEvents: 'none', // CANNOT block a click — see this module's header
      background: 'rgba(90, 20, 20, 0.92)',
      color: '#ffd9d9',
      font: '12px/1.4 ui-monospace, Consolas, monospace',
      padding: '6px 12px',
      borderBottom: '2px solid #ff4d4d',
      textAlign: 'center',
    });
    el.textContent = `⚠ Map Shine Advanced is NOT rendering — Foundry's own renderer is drawing this scene. ${reason}`;
    resolveHost().appendChild(el);
  } catch (_) {
    // A missing notice must not also cost the player their session.
  }

  // 3. The notification draws the eye; the banner is what persists.
  try {
    globalThis.ui?.notifications?.error?.(
      `Map Shine Advanced could not start its renderer and has fallen back to Foundry's own rendering. ${reason}`,
      { permanent: true }
    );
  } catch (_) {}

  return { fellBack: true, reason };
}

/** MSA's renderer came up. Clear any prior fallback notice. */
export function clearFoundryFallback() {
  try {
    document.getElementById(NOTICE_ID)?.remove();
  } catch (_) {}
  state.active = false;
  state.reason = null;
  state.detail = null;
  state.at = null;
  return { cleared: true };
}

/** @returns {{active:boolean, reason:string|null, detail:string|null, at:string|null}} live fallback state. */
export function getFallbackState() {
  return { ...state };
}

/**
 * THE QUESTION THAT COULD NOT BE ANSWERED FROM A REPORT: *is the thing I am
 * looking at MSA, or Foundry?*
 *
 * During the 2026-07-16 non-square incident there was no way to tell from a
 * pasted diagnostic whether MSA was rendering at all — the report described its
 * internals in exhaustive detail while saying nothing about whether any of it
 * reached the screen. Answered here from DOM ground truth rather than intent: an
 * object that believes it is rendering is exactly the object whose belief is in
 * question.
 *
 * @param {object} args
 * @param {HTMLCanvasElement|null} args.canvas - MSA's canvas.
 * @param {boolean} args.loopActive - is the render loop running?
 * @returns {{renderMode: 'msa'|'foundry-fallback', occludingPixi: boolean,
 *            renderModeReason: string|null,
 *            fallback: {active:boolean, reason:string|null, detail:string|null, at:string|null}}}
 */
export function describeRenderMode({ canvas, loopActive }) {
  const fallback = getFallbackState();
  const no = (renderModeReason) => ({
    renderMode: 'foundry-fallback',
    occludingPixi: false,
    renderModeReason,
    fallback,
  });
  try {
    if (!canvas) return no("no MSA canvas exists — Foundry's own canvas is what you are seeing");
    if (!document.contains(canvas))
      return no("MSA's canvas is not in the document — Foundry's own canvas is what you are seeing");
    if (!(canvas.width > 0 && canvas.height > 0))
      return no(`MSA's canvas has a zero drawing buffer (${canvas.width}x${canvas.height})`);
    const cs = getComputedStyle(canvas);
    if (cs.display === 'none') return no("MSA's canvas is display:none");
    if (cs.visibility === 'hidden') return no("MSA's canvas is visibility:hidden");
    if (Number(cs.opacity) === 0) return no("MSA's canvas is fully transparent (opacity 0)");
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2)
      return no(`MSA's canvas occupies no screen area (${Math.round(rect.width)}x${Math.round(rect.height)})`);
    // Mounted and visible but NOT painting — the state that used to be
    // indistinguishable from "a working scene with dark art", AND the state that
    // used to block the fallback: an opaque black rectangle over a healthy
    // Foundry canvas. Reported as its own thing rather than folded into either.
    if (!loopActive) {
      return {
        renderMode: 'msa',
        occludingPixi: true,
        renderModeReason:
          "MSA's canvas is mounted and occluding Foundry, but its render loop is NOT running — any black you see is the canvas background, not rendered output",
        fallback,
      };
    }
    return { renderMode: 'msa', occludingPixi: true, renderModeReason: null, fallback };
  } catch (err) {
    return no(`could not determine render mode: ${String(err?.message || err)}`);
  }
}
