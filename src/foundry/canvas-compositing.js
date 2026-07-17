/**
 * THE INTERFACE SEAM — MSA owns the ART, Foundry's PIXI keeps the CHROME.
 *
 * ============================================================================
 * THE FINDING (2026-07-17): Foundry already draws the line we need.
 * ============================================================================
 *
 * `CONFIG.Canvas.layers` (client/config.mjs:703) assigns every canvas layer to
 * a group, and the split is exact:
 *
 *   primary   -> the ART. Every token/tile/background sprite. (+ `weather`)
 *   effects   -> lighting, vision, darkness
 *   interface -> tokens, tiles, walls, grid, controls, notes, lighting,
 *                drawings, templates, regions, sounds — EVERY interactive layer
 *
 * And `Token#_draw` (placeables/token.mjs:1211) splits one object down the
 * same line:
 *
 *     this.mesh = canvas.primary.addToken(this);           // ART   -> primary
 *     this.border ||= this.addChild(new PIXI.Graphics());  // CHROME -> interface
 *
 * The token's PICTURE goes to `primary`. Its selection border, bars, target
 * pips and hit area stay on the Token, in `interface`. So MSA replaces
 * `primary` + `effects` and leaves `interface` alone — that is not a clever
 * trick, it is Foundry's own architecture.
 *
 * ============================================================================
 * WHY THIS IS NOT V2's BLUNDER (Engine-Postmortem.md §1)
 * ============================================================================
 *
 * V2's root blunder was NOT "PIXI and Three coexist". It was TWO RENDERERS,
 * BOTH AUTHORITATIVE FOR THE SAME PICTURE — both drew the scene art, so 1,838
 * lines existed purely to make them agree, and they still did not.
 *
 * Here the two renderers draw DISJOINT SETS. There is no shared picture, so
 * there is nothing to reconcile and no sync code to write. `interaction-
 * manager.js`'s 8,955 lines of re-implemented selection stay dead. Same move as
 * mirroring `canvas.stage` instead of owning a camera (keyhole-input-model-
 * decision), applied to OUTPUT instead of input.
 *
 * >>> If you ever find yourself writing code to keep MSA and PIXI in agreement
 * >>> about a pixel, STOP. You are re-growing frame-coordinator.js. They must
 * >>> never draw the same thing.
 *
 * ============================================================================
 * THE BUG THIS FIXES
 * ============================================================================
 *
 * MSA's canvas was `zIndex: 5`, `background: #000` (OPAQUE), mounted as a
 * sibling of `canvas#board` (which is `z-index: var(--z-index-canvas)` = 0,
 * verified foundry2.css:15108). So MSA sat ON TOP of the entire PIXI canvas:
 *
 *   - INPUT worked. `pointer-events: none` let clicks through; Foundry
 *     hit-tested; documents updated. Selection genuinely functioned.
 *   - OUTPUT was dead. Selection borders, control icons, walls, grid, rulers,
 *     targets, door controls and drag previews all render into `#board` —
 *     behind an opaque black canvas. Invisible.
 *
 * Keyhole.md said "token selection may not need building at all (Foundry
 * hit-tests)". True, and only half the question: it answers where the CLICK
 * goes and never asks where the BORDER gets drawn.
 *
 * ============================================================================
 * THE MECHANISM — all public API, all source-verified, no monkey-patching
 * ============================================================================
 *
 * 1. `canvasConfig` (board.mjs:723) fires `Hooks.callAll("canvasConfig", config)`
 *    on a MUTABLE options object immediately before `new PIXI.Application`.
 *    We set `backgroundAlpha = 0` there.
 *
 *    ⚠️ THIS HOOK IS THE ONLY CHANCE, EVER. PIXI's ContextSystem.init
 *    (pixi.js 7.4.3, dist/pixi.js:5535) derives the GL context's `alpha`
 *    attribute from the background alpha AT CONTEXT CREATION:
 *
 *        const alpha = this.renderer.background.alpha < 1;
 *        ... this.initFromOptions({ alpha, ... })
 *
 *    WebGL context attributes are immutable after creation. Set
 *    `backgroundAlpha` later and the context is already `alpha: false` — the
 *    canvas is opaque for the rest of the session and NOTHING can fix it.
 *
 *    (Foundry's own `transparent: false` on board.mjs:717 is VESTIGIAL: PIXI v7
 *    removed `transparent`; BackgroundSystem.init reads only `backgroundAlpha`.
 *    Do not "fix" it by setting `transparent: true` — it is not read.)
 *
 * 2. `initializeCanvasEnvironment` (groups/environment.mjs:201) — THE TRAP, and
 *    it would have been vicious to diagnose live. `EnvironmentCanvasGroup#
 *    initialize()` line 179 does:
 *
 *        canvas.app.renderer.background.color = this.colors.rendererBackground;
 *
 *    PIXI's `set color` -> `Color#setValue` -> `set value` -> `normalize()`
 *    (dist/pixi.js:1695-1711), and for a bare number `a2 = 1` is FORCED into
 *    the alpha component; for a Color instance the components (incl. alpha) are
 *    copied wholesale. Line 1527 only skips this when the colour is UNCHANGED.
 *
 *    So Foundry RESETS our clear alpha to 1 whenever the environment background
 *    colour changes — scene load, darkness change, a lighting preview. The
 *    canvas would go transparent at boot and silently turn opaque the first
 *    time the sun set. `initializeCanvasEnvironment` fires as the LAST statement
 *    of that same `initialize()` (line 201, right after line 179), so it is the
 *    exact, public, source-verified place to re-assert.
 *
 *    This is NOT frame-coordinator sync code: it is one idempotent assignment
 *    reacting to one named event that provably clobbers one field. It does not
 *    reconcile two sources of truth — Foundry remains the only owner of the
 *    clear colour; we own one channel of it.
 *
 * 3. `canvas.environment.renderable = false` — kills `primary` + `effects`.
 *    `CachedContainer#render` early-returns on `!this.renderable`
 *    (containers/advanced/cached-container.mjs:211), and `primary` already sets
 *    `eventMode = "none"` (groups/primary.mjs:30) so nothing hit-tests through
 *    it anyway. `renderable` (not `visible`): PIXI's EventBoundary skips
 *    INVISIBLE subtrees when hit-testing, and we must never disturb hit-testing.
 *
 * 4. MSA's canvas drops `pointer-events: none` and stacks BELOW `#board`. The
 *    hack becomes unnecessary: a canvas underneath cannot swallow a click.
 *
 * ============================================================================
 * THE COUPLING RULE — why `decideArtSuppression` exists (the safety slide)
 * ============================================================================
 *
 * The two halves must never land apart. Suppress Foundry's art while the PIXI
 * canvas is still OPAQUE and you get the worst state available: a blank scene
 * with floating selection borders and no art from EITHER renderer. That is
 * strictly worse than doing nothing.
 *
 * So suppression is a DECISION taken from measured facts, defaulting to REFUSE
 * (feedback_safety_slide_outranks_doctrine: fall back to Foundry by default,
 * announce always, never silently). Every refusal carries a `code` and a
 * `reason` — "I could not measure this" never looks like "the thing is broken"
 * (Keyhole doctrine #5, feedback_instruments_must_not_lie).
 *
 * ============================================================================
 * NOT DONE HERE, ON PURPOSE
 * ============================================================================
 *
 * - `canvas.visibility` (fog/vision) is a THIRD group, sibling of `environment`
 *   under `rendered`. It is deliberately LEFT WITH PIXI. The author's direction
 *   (2026-07-17, keyhole-vision-fog-direction) is that MSA takes fog+vision
 *   EVENTUALLY — reproducing Foundry's logic, rendering it with Three's
 *   strengths (smooth fog). When that day comes it is the same lever
 *   (`renderable = false`) applied to one more group. Keep this per-group and
 *   reversible so that stays an addition, not a rewrite.
 * - The DRAG PREVIEW's art. A preview Token is a real Token, so its `_draw`
 *   also pushes a mesh into `primary` — suppressed with everything else. MSA
 *   draws from DOCUMENTS and a preview is not a document; it lives at
 *   `canvas.tokens.preview.children` (layers/base/placeables-layer.mjs:47).
 *   Expect to drag an outline with no picture until that is wired. Real,
 *   bounded, and NOT silently pretended away.
 */

/** The Foundry canvas groups MSA takes over. `visibility` is NOT among them — see the header. */
export const MSA_OWNED_GROUPS = Object.freeze(['primary', 'effects']);

/**
 * THE DECISION, pure and Node-tested. Given what we could actually MEASURE,
 * may we suppress Foundry's art?
 *
 * Defaults to REFUSE on every unknown. Refusing means Foundry renders normally
 * and MSA is simply invisible underneath — a working table with no MSA. That is
 * the safety slide's whole point, and it is always better than the alternative
 * failure (art suppressed under an opaque canvas = nothing renders at all).
 *
 * @param {object} facts
 * @param {boolean|null} facts.contextAlpha - the GL context's `alpha` attribute.
 *   `null` = could not read. IMMUTABLE for the session once the context exists.
 * @param {number|null} facts.clearAlpha - `renderer.background.alpha`. `null` =
 *   could not read.
 * @param {boolean} facts.environmentPresent - is `canvas.environment` there to suppress?
 * @returns {{suppress: boolean, code: string, reason: string}}
 */
export function decideArtSuppression({ contextAlpha, clearAlpha, environmentPresent }) {
  if (contextAlpha === null || contextAlpha === undefined) {
    return {
      suppress: false,
      code: 'context-alpha-unknown',
      reason:
        'Could not read the WebGL context alpha attribute. This is "not measured", NOT "broken" — ' +
        'refusing because suppressing art on an unknown is the dangerous direction.',
    };
  }
  if (contextAlpha === false) {
    return {
      suppress: false,
      code: 'context-opaque',
      reason:
        'The PIXI WebGL context was created with alpha:false, so its canvas can NEVER be transparent ' +
        'this session (context attributes are immutable). The canvasConfig hook did not take — it must ' +
        'be registered before Foundry\'s Canvas#initialize, which runs between the "setup" and "ready" hooks.',
    };
  }
  if (clearAlpha === null || clearAlpha === undefined) {
    return {
      suppress: false,
      code: 'clear-alpha-unknown',
      reason: 'Could not read renderer.background.alpha. Not measured, not broken — refusing on the unknown.',
    };
  }
  if (clearAlpha > 0) {
    return {
      suppress: false,
      code: 'clear-alpha-opaque',
      reason:
        `renderer.background.alpha is ${clearAlpha}, so PIXI clears its canvas opaque every frame and ` +
        'MSA underneath would be invisible. Foundry resets this whenever the environment background ' +
        'colour changes (environment.mjs:179) — the initializeCanvasEnvironment re-assert did not run.',
    };
  }
  if (!environmentPresent) {
    return {
      suppress: false,
      code: 'no-environment',
      reason: 'canvas.environment does not exist yet — nothing to suppress. Normal before a scene is drawn.',
    };
  }
  return {
    suppress: true,
    code: 'ok',
    reason: 'PIXI canvas is verifiably transparent; Foundry art can be suppressed safely.',
  };
}

/**
 * Read the real compositing facts from live PIXI/Foundry. GROUND TRUTH ONLY —
 * every field is read from the thing itself, never inferred from what we asked
 * for. A field is `null` when it could not be read, and `null` is never
 * conflated with a real value.
 *
 * @returns {{contextAlpha: boolean|null, clearAlpha: number|null,
 *   environmentPresent: boolean, environmentRenderable: boolean|null, readErrors: string[]}}
 */
export function readCompositingFacts() {
  const readErrors = [];
  const app = typeof canvas !== 'undefined' ? canvas?.app : null;

  let contextAlpha = null;
  try {
    // The context's OWN attributes, not the options we passed in. This is the
    // difference between "what we asked for" and "what we got".
    const gl = app?.renderer?.gl ?? null;
    const attrs = gl?.getContextAttributes?.() ?? null;
    if (attrs) contextAlpha = attrs.alpha === true;
    else readErrors.push('no GL context attributes available (renderer.gl missing or not WebGL)');
  } catch (err) {
    readErrors.push(`getContextAttributes threw: ${err?.message ?? err}`);
  }

  let clearAlpha = null;
  try {
    const a = app?.renderer?.background?.alpha;
    if (typeof a === 'number') clearAlpha = a;
    else readErrors.push('renderer.background.alpha is not a number (PIXI API drift?)');
  } catch (err) {
    readErrors.push(`reading renderer.background.alpha threw: ${err?.message ?? err}`);
  }

  const env = typeof canvas !== 'undefined' ? (canvas?.environment ?? null) : null;
  const environmentPresent = !!env;
  let environmentRenderable = null;
  try {
    if (env && typeof env.renderable === 'boolean') environmentRenderable = env.renderable;
  } catch (err) {
    readErrors.push(`reading canvas.environment.renderable threw: ${err?.message ?? err}`);
  }

  return { contextAlpha, clearAlpha, environmentPresent, environmentRenderable, readErrors };
}

/** Re-assert the transparent clear alpha after Foundry clobbers it. See header §2. */
function reassertClearAlpha() {
  try {
    const bg = typeof canvas !== 'undefined' ? canvas?.app?.renderer?.background : null;
    if (!bg) return false;
    if (bg.alpha === 0) return true; // already right; do not touch
    bg.alpha = 0;
    return true;
  } catch (err) {
    console.error(
      '[MSA] canvas-compositing: could not re-assert transparent clear alpha. Foundry art will ' +
        'stay opaque and MSA will be invisible underneath (this is the safe direction):',
      err
    );
    return false;
  }
}

/**
 * Apply (or refuse) art suppression, from measured facts. Idempotent — safe to
 * call on every canvasReady.
 *
 * @returns {{applied: boolean, code: string, reason: string, facts: object}}
 */
export function applyArtSuppression() {
  const facts = readCompositingFacts();
  const decision = decideArtSuppression(facts);

  if (!decision.suppress) {
    // ANNOUNCE, ALWAYS — never a silent fallback (feedback_safety_slide_outranks_doctrine).
    // 'no-environment' is the one benign case: it just means no scene is drawn yet.
    if (decision.code !== 'no-environment') {
      console.warn(
        `[MSA] interface seam: NOT suppressing Foundry's art (${decision.code}) — ${decision.reason} ` +
          'Foundry is rendering the scene normally; MSA is underneath and invisible.'
      );
    }
    return { applied: false, code: decision.code, reason: decision.reason, facts };
  }

  try {
    canvas.environment.renderable = false;
  } catch (err) {
    console.error('[MSA] interface seam: suppressing canvas.environment failed:', err);
    return {
      applied: false,
      code: 'suppress-threw',
      reason: `Setting canvas.environment.renderable = false threw: ${err?.message ?? err}`,
      facts,
    };
  }
  return { applied: true, code: decision.code, reason: decision.reason, facts };
}

/**
 * Hand Foundry's art back. The reverse of applyArtSuppression, for the safety
 * slide's "fall back to Foundry" path and for Stop/Clear.
 *
 * @returns {boolean} whether the restore actually happened
 */
export function restoreFoundryArt() {
  try {
    const env = typeof canvas !== 'undefined' ? (canvas?.environment ?? null) : null;
    if (!env) return false;
    env.renderable = true;
    return true;
  } catch (err) {
    console.error('[MSA] interface seam: restoring canvas.environment failed:', err);
    return false;
  }
}

/**
 * Register the two hooks that make the seam work. MUST be called at module load
 * (Foundry's Canvas#initialize runs between the "setup" and "ready" hooks, and
 * `canvasConfig` fires inside it — see header §1: there is no second chance).
 *
 * @returns {{registered: boolean, reason: string|null}}
 */
export function registerCanvasCompositing() {
  if (typeof Hooks === 'undefined') {
    return { registered: false, reason: 'no Foundry Hooks global — not running inside Foundry' };
  }

  // §1 — the one-shot that decides the GL context's alpha attribute forever.
  Hooks.once('canvasConfig', (config) => {
    try {
      config.backgroundAlpha = 0;
    } catch (err) {
      console.error(
        '[MSA] interface seam: could not set backgroundAlpha on the canvasConfig options. The PIXI ' +
          'canvas will be OPAQUE for this whole session and MSA cannot show through it. Foundry will ' +
          'render normally (the safe fallback):',
        err
      );
    }
  });

  // §2 — re-assert after Foundry's environment colour update clobbers the alpha.
  Hooks.on('initializeCanvasEnvironment', () => {
    reassertClearAlpha();
  });

  return { registered: true, reason: null };
}

/**
 * The debug-panel report. Answers the only question that matters — is the seam
 * actually live? — from measured facts, not from what we intended.
 */
export function getCanvasCompositingReport() {
  const facts = readCompositingFacts();
  const decision = decideArtSuppression(facts);
  return {
    report: 'interface-seam',
    generatedAt: new Date().toISOString(),
    contextAlpha: facts.contextAlpha,
    clearAlpha: facts.clearAlpha,
    environmentPresent: facts.environmentPresent,
    environmentRenderable: facts.environmentRenderable,
    readErrors: facts.readErrors,
    decision,
    msaOwnedGroups: [...MSA_OWNED_GROUPS],
    interpretation:
      'HEALTHY = contextAlpha:true, clearAlpha:0, environmentRenderable:false. That means the PIXI ' +
      "canvas is genuinely transparent, Foundry's art is off, and its interface chrome (selection " +
      'borders, grid, walls, control icons, rulers) is drawing on top of MSA. ' +
      'contextAlpha:false is UNRECOVERABLE this session — the canvasConfig hook did not run in time. ' +
      'clearAlpha:1 with contextAlpha:true means Foundry re-clobbered the alpha and the ' +
      'initializeCanvasEnvironment re-assert is not firing. ' +
      'environmentRenderable:true alongside a refusal is CORRECT and deliberate — the safety slide ' +
      'chose Foundry rendering over a blank screen; read decision.reason for which fact forced it.',
  };
}
