/**
 * @fileoverview diag/failure-surface.js — make a renderer failure impossible to
 * mistake for anything else.
 *
 * ## The problem, stated precisely (the original diagnosis was half wrong)
 *
 * The claim was "a VT failure lets Foundry's PIXI canvas render underneath, so
 * failure looks like success." Reading the actual order, that is only sometimes
 * true, and the common case is different — and arguably worse:
 *
 * - `vt-pan-viewer.js` appends its canvas EARLY (before the WebGL renderer is
 *   even constructed) and the canvas carries `background:#000`. So almost every
 *   failure — including a dead WebGL context, or the non-square throw that
 *   prompted this — leaves a **black rectangle** that DOES still occlude PIXI.
 *   Loud, in the sense that you cannot see your map. Completely undiagnosable,
 *   in the sense that black is indistinguishable from "still loading", "the
 *   scene is empty", "the art is dark", or "the module is broken".
 * - There IS one genuinely silent path: `boot.js` bails BEFORE calling
 *   `startVtPanViewer` when a scene has no usable Level art. No canvas is ever
 *   mounted, PIXI renders, and the failure is invisible.
 *
 * So two distinct bugs wearing one costume: an *uninformative* failure and an
 * *invisible* one. This module fixes both with one surface.
 *
 * ## Why a DOM overlay and not "draw the error on the canvas"
 *
 * The single most important failure to report is **"WebGL is unavailable or the
 * context died"** — precisely the weak/aging-GPU case this entire project exists
 * for. An error surface that needs a working GL context to display itself cannot
 * report the one failure that matters most. A plain DOM element always renders.
 *
 * ## Why an opaque surface rather than a notification
 *
 * A notification is dismissible, missable, and — critically — does not stop PIXI
 * from drawing. That would leave the module quietly served by the renderer we
 * severed from, which is exactly what Keyhole.md §0 doctrine #1 forbids: *"If a
 * capability isn't built yet, the feature is absent and fails loudly — it is
 * never quietly served by V2."* Occluding PIXI is the VT canvas's whole job; a
 * FAILED VT must keep doing that job and say why.
 *
 * This is not in tension with the sanctioned `useNativeFoundryRendering`
 * off-switch (§4.3, Q5). That is a deliberate, top-level, whole-system mode
 * where MSA is off and PIXI is *supposed* to render. This surface only ever
 * appears when MSA was meant to be running and could not.
 *
 * @module diag/failure-surface
 */

const SURFACE_ID = 'msa-vt-failure-surface';

/**
 * Where the surface mounts: the same host the VT canvas uses, so it covers
 * exactly what the VT would have. Mirrors `vt-pan-viewer.js#resolveMountHost`
 * deliberately rather than importing it — `diag/` must not depend on `vt/`, and
 * a failure reporter that breaks when the thing it reports on breaks is useless.
 * @returns {HTMLElement}
 */
function resolveHost() {
  const board = typeof document !== 'undefined' ? document.getElementById('board') : null;
  return board?.parentElement ?? document.body;
}

/**
 * Show the failure surface. Idempotent — calling again replaces the message.
 *
 * z-index 6 sits ABOVE the VT canvas (5) so it covers a black/broken canvas, and
 * BELOW Foundry's UI (60) and the debug panel (90) — so the GM can still reach
 * their controls and paste a report. Failing loudly must not mean trapping the
 * user with no way to act.
 *
 * @param {object} args
 * @param {string} args.title - the one-line "what broke".
 * @param {string} [args.detail] - the real error text/stack. Rendered as TEXT
 *   (never innerHTML) — an error message is untrusted input, and a reporter that
 *   can be made to inject markup is its own bug.
 * @param {string} [args.hint] - what the reader should do next.
 * @returns {{shown: true}}
 */
export function showFailureSurface({ title, detail, hint }) {
  clearFailureSurface();
  const el = document.createElement('div');
  el.id = SURFACE_ID;
  Object.assign(el.style, {
    position: 'absolute',
    inset: '0',
    zIndex: '6',
    background: '#1b0a0a',
    color: '#ffd9d9',
    font: '13px/1.5 ui-monospace, Consolas, monospace',
    padding: '24px',
    overflow: 'auto',
    pointerEvents: 'auto',
    borderLeft: '4px solid #ff4d4d',
  });

  const h = document.createElement('div');
  h.textContent = '⛔ Map Shine Advanced — the renderer failed to start.';
  Object.assign(h.style, { fontSize: '16px', fontWeight: '700', color: '#ff8080', marginBottom: '12px' });
  el.appendChild(h);

  const t = document.createElement('div');
  t.textContent = title;
  Object.assign(t.style, { marginBottom: '12px', whiteSpace: 'pre-wrap' });
  el.appendChild(t);

  if (detail) {
    const d = document.createElement('pre');
    d.textContent = detail; // TEXT, never innerHTML — see this function's doc
    Object.assign(d.style, {
      margin: '0 0 12px',
      padding: '10px',
      background: '#00000055',
      whiteSpace: 'pre-wrap',
      maxHeight: '40vh',
      overflow: 'auto',
    });
    el.appendChild(d);
  }

  const foot = document.createElement('div');
  foot.textContent =
    hint ??
    'This surface is deliberate: it keeps Foundry\'s own canvas occluded so a failure can never be mistaken for a working scene. Open the MSA debug panel and run "VT Pan Viewer: Diagnostics" for the full state.';
  Object.assign(foot.style, { color: '#ffb4b4', opacity: '0.85' });
  el.appendChild(foot);

  resolveHost().appendChild(el);
  return { shown: true };
}

/** Remove the surface (a later start succeeded). Safe to call when absent. */
export function clearFailureSurface() {
  try {
    document.getElementById(SURFACE_ID)?.remove();
  } catch (_) {
    // Never let the failure reporter throw — it runs on the failure path.
  }
  return { cleared: true };
}

/** @returns {boolean} is the failure surface currently on screen? */
export function isFailureSurfaceShown() {
  try {
    return !!document.getElementById(SURFACE_ID);
  } catch (_) {
    return false;
  }
}

/**
 * THE QUESTION THAT COULD NOT BE ANSWERED FROM A REPORT: *is the thing I am
 * looking at actually the VT, or is it Foundry's own canvas?*
 *
 * During the 2026-07-16 non-square incident there was no way to tell from a
 * pasted diagnostic whether the VT was rendering at all — the report described
 * the VT's internal state in detail while saying nothing about whether any of it
 * reached the screen. This answers it from DOM/GL ground truth rather than from
 * intent: an object that believes it is rendering is exactly the object whose
 * belief is in question.
 *
 * @param {object} args
 * @param {HTMLCanvasElement|null} args.canvas - the VT canvas.
 * @param {boolean} args.loopActive - is the render loop running?
 * @returns {{occludingPixi: boolean, reason: string|null, failureSurfaceShown: boolean}}
 *   `reason` is null on success, else the FIRST thing found wrong.
 */
export function describeOcclusionOfPixi({ canvas, loopActive }) {
  const failureSurfaceShown = isFailureSurfaceShown();
  const no = (reason) => ({ occludingPixi: false, reason, failureSurfaceShown });
  try {
    if (!canvas) return no("no VT canvas exists — Foundry's own canvas is what you are seeing");
    if (!document.contains(canvas))
      return no("the VT canvas is not in the document — Foundry's own canvas is what you are seeing");
    if (!(canvas.width > 0 && canvas.height > 0))
      return no(`the VT canvas has a zero drawing buffer (${canvas.width}x${canvas.height})`);
    const cs = getComputedStyle(canvas);
    if (cs.display === 'none') return no('the VT canvas is display:none');
    if (cs.visibility === 'hidden') return no('the VT canvas is visibility:hidden');
    if (Number(cs.opacity) === 0) return no('the VT canvas is fully transparent (opacity 0)');
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2)
      return no(`the VT canvas occupies no screen area (${Math.round(rect.width)}x${Math.round(rect.height)})`);
    // Mounted and visible, but not painting: the canvas still occludes PIXI via
    // its own black CSS background, which is the "loud but undiagnosable black
    // rectangle" case this module exists to name rather than leave to guesswork.
    if (!loopActive)
      return no(
        'the VT canvas is mounted but its render loop is NOT running — the black rectangle is the canvas background, not rendered output'
      );
    return { occludingPixi: true, reason: null, failureSurfaceShown };
  } catch (err) {
    return no(`could not determine occlusion state: ${String(err?.message || err)}`);
  }
}
