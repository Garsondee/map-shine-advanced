/**
 * tools/preview-shared/page-setup.js — what a preview harness needs before it
 * mounts a room, so the room is judged the way it will look INSIDE FOUNDRY.
 *
 * ============================================================================
 * `?foundry=<url of foundry2.css>` — LOAD FOUNDRY'S REAL CORE STYLESHEET
 * ============================================================================
 * The harnesses used to run on a bare page, which hid most of what is wrong with
 * a room. Foundry styles every bare `button`, `input`, `select`, `h2`, `kbd` and
 * `input[type=range]` (`button{height:2em; min-height:2em; transition:0.5s;
 * padding:0 .5rem; border:1px solid <brown>}`, an orange `:hover`, a glowing
 * `:focus`, a serif `h2`, `select{width:100%}`), and none of that exists in a
 * harness unless it is loaded on purpose. The Studio audit of 2026-10-18 only
 * found the 28×27 circular switch and the 0.5s state changes once the real file
 * was in the page; the Remote and Player audit did the same.
 *
 * Foundry ships the file at `<install>/resources/app/public/css/foundry2.css`
 * (its fonts sit beside it). Serve that `public/` folder from any static server
 * that sends `Access-Control-Allow-Origin: *`, then open a harness with
 *   ?foundry=http://localhost:8942/css/foundry2.css
 * It is loaded with `crossorigin="anonymous"` so a script can also READ the
 * rules (`document.styleSheets[n].cssRules`) — that is how the audits list every
 * `:hover`/`:active`/`:focus` rule that reaches a control. The body gets the
 * classes Foundry's own page has (`game theme-dark`). Foundry's rules all sit in
 * `@layer`s, so MSA's plain unlayered rules win without `!important`; that is
 * exactly the relationship this loads, so what the harness shows is what the
 * table will see.
 *
 * ============================================================================
 * `?pane=1` — FOR THE DESKTOP APP'S BACKGROUND BROWSER PANE
 * ============================================================================
 * That pane is a BACKGROUND page: `requestAnimationFrame` never fires in it, and
 * it reports `prefers-reduced-motion`, which flattens every transition. Neither
 * is true in a real tab. With `?pane=1`, rAF becomes a 16ms timer (with a forced
 * style flush, so a transition started "next frame" has a "before" to start
 * from), and the reduced-motion rule is stripped from the installed token
 * sheet. Motion can then be checked with `el.getAnimations()` rather than by eye.
 * Never enable it in a real browser.
 *
 * @module tools/preview-shared/page-setup
 */

const TOKEN_STYLE_ID = 'msa-lantern-tokens';

/** @param {string} href @returns {Promise<void>} resolves when the sheet has loaded (or failed — a harness still opens). */
function loadStylesheet(href) {
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.crossOrigin = 'anonymous';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => {
      console.warn(`[preview] could not load ${href} — is the Foundry css server running?`);
      resolve();
    };
    document.head.appendChild(link);
  });
}

/** rAF as a timer, plus a style flush so the next frame has a computed "before". */
function installPaneShims() {
  window.requestAnimationFrame = (cb) =>
    setTimeout(() => {
      void document.body?.offsetHeight;
      cb(performance.now());
    }, 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
}

/** Drop the `prefers-reduced-motion` block from the token sheet (call after installTokens()). */
export function stripReducedMotionRule() {
  const style = document.getElementById(TOKEN_STYLE_ID);
  if (!style) return;
  style.textContent = style.textContent.replace(/@media \(prefers-reduced-motion: reduce\)\{[^}]*\{[^}]*\}\s*\}/, '');
}

/**
 * Call once, first thing, with `await`. Reads `?foundry=` and `?pane=`.
 * @returns {Promise<{foundry: boolean, pane: boolean}>}
 */
export async function preparePreviewPage() {
  const params = new URLSearchParams(window.location.search);
  const foundryHref = params.get('foundry');
  const pane = params.get('pane') === '1';
  if (pane) installPaneShims();
  if (foundryHref) {
    document.body.classList.add('game', 'theme-dark');
    await loadStylesheet(foundryHref);
  }
  return { foundry: Boolean(foundryHref), pane };
}
