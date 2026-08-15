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
 * 3. Suppress `primary` + `effects` WITHOUT freezing `primary`'s internal
 *    cache (rewritten 2026-08-13 — see "THE PRIMARY-CACHE-FREEZE FIX" below
 *    for why the original single-lever version broke Foundry's own fog
 *    shader). Two separate, more surgical moves:
 *
 *      canvas.primary.sprite.renderable = false;   // hides primary's OUTPUT only
 *      canvas.effects.renderable = false;           // effects has no cache to protect
 *
 *    `primary` itself (and hence `CachedContainer#render`'s cache-refresh
 *    half — containers/advanced/cached-container.mjs:209-221) is left
 *    running every frame. `primary` already sets `eventMode = "none"`
 *    (groups/primary.mjs:36) so nothing hit-tests through it regardless of
 *    which lever suppresses it. `renderable` (not `visible`), same reason as
 *    always: PIXI's EventBoundary skips INVISIBLE subtrees when hit-testing,
 *    and we must never disturb hit-testing.
 *
 * 4. MSA's canvas drops `pointer-events: none` and stacks BELOW `#board`. The
 *    hack becomes unnecessary: a canvas underneath cannot swallow a click.
 *
 * ============================================================================
 * THE PRIMARY-CACHE-FREEZE FIX (2026-08-13) — why §3 changed from one lever
 * to two, source-verified line-by-line, not guessed
 * ============================================================================
 *
 * The original version of this file suppressed with one assignment:
 * `canvas.environment.renderable = false`. `canvas.environment` is the
 * literal PIXI PARENT of `canvas.primary` (groups/environment.mjs:21, "A
 * container group which contains the primary canvas group and the effects
 * canvas group"), and neither it nor `CanvasGroupMixin` override `render()` —
 * it is the stock `PIXI.Container#render()`, which early-returns on
 * `!this.renderable` BEFORE walking `this.children`. So suppressing the
 * PARENT didn't just hide `canvas.primary` — it meant PIXI never called
 * `canvas.primary.render(renderer)` AT ALL.
 *
 * `canvas.primary` is a `CachedContainer` (groups/primary.mjs:29,
 * `PrimaryCanvasGroup extends CanvasGroupMixin(CachedContainer)`), and
 * `CachedContainer#render()` is where its children (background/tiles/
 * tokens/weather) get re-rendered into `canvas.primary.renderTexture` — an
 * internal cache, gated by that SAME `!renderable` early-return. Never
 * reached ⇒ that render texture froze solid at whatever it held the instant
 * suppression engaged (effectively scene boot), and nothing about that was
 * visible... until Foundry's OWN fog-of-war shader turned out to depend on
 * it: `CanvasVisibility#_draw()` builds its `VisibilityFilter` with
 * `primaryTexture: canvas.primary.renderTexture` (groups/visibility.mjs:336),
 * and the fragment shader's "explored, not-currently-visible" fog zone
 * (rendering/filters/visibility.mjs:140,149) blends 50% of that frozen
 * snapshot UNDER whatever MSA renders live. Because the shader samples it in
 * screen space (`filterMaskTextureCoord`, same file:91), not world space, the
 * frozen snapshot fills the current viewport regardless of camera position —
 * it reads as a second, camera-locked copy of the map ghosted under MSA's
 * own correctly camera-tracked render. Author-reported 2026-08-13 ("I see a
 * double set of albedos and one of them moves... the other one stays
 * still"), traced to here, tracked as Bug #18 in `docs/planning/
 * Bug-Tracker.md`. Full source trail: memory
 * `keyhole-fog-shader-primary-texture-freeze`.
 *
 * Nobody had exercised this path before, because `canvas.visibility.visible`
 * (the whole group this filter lives in) only goes true once a vision
 * source is active (groups/visibility.mjs:489) — a GM with no controlled
 * token never rendered it, which is how almost every prior live-testing
 * session was conducted.
 *
 * The fix: split "keep the cache fresh" from "show the cache on screen".
 * `CachedContainer#render()` already has this split built in — an
 * unconditional `this.#sprite?.render(renderer)` blit (the normal on-screen
 * path) plus a SEPARATE `displayed`-gated raw re-render (default `false`,
 * unused here). Suppressing the bound `sprite`'s OWN `renderable` stops only
 * the blit; `canvas.primary`'s own `renderable` stays `true` (its default),
 * so the cache-refresh block keeps running every frame, feeding Foundry's
 * fog shader (and anything else that reads `canvas.primary.renderTexture`)
 * correctly. `canvas.effects` never had this failure mode — it's a plain
 * `PIXI.Container` (groups/effects.mjs:31), not a `CachedContainer` — so it
 * keeps being suppressed the simple way, just no longer riding on
 * `environment`'s shared lever.
 *
 * Cost, honestly stated: this gives back some of the render-to-texture work
 * MSA previously skipped by suppressing at the parent level — the same cost
 * vanilla Foundry (no MSA) already pays every frame as normal operation.
 * Measure before assuming it matters (feedback_measure_the_output_not_the_
 * equation) — do not re-introduce the parent-level shortcut to "optimize"
 * this without re-deriving that it doesn't reopen the frozen-texture bug.
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
 *   strengths (smooth fog), which would obsolete the whole primary-texture
 *   dependency above at once. Until then, §3's two-lever suppression is the
 *   scoped fix. Keep suppression per-group and reversible so that day is an
 *   addition, not a rewrite.
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
 * @param {boolean} facts.groupsPresent - do `canvas.primary`, `canvas.primary.sprite`
 *   and `canvas.effects` all exist to suppress?
 * @returns {{suppress: boolean, code: string, reason: string}}
 */
export function decideArtSuppression({ contextAlpha, clearAlpha, groupsPresent }) {
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
  if (!groupsPresent) {
    return {
      suppress: false,
      code: 'no-render-targets',
      reason:
        'canvas.primary / canvas.primary.sprite / canvas.effects do not all exist yet — nothing to ' +
        'suppress. Normal before a scene is drawn.',
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
 *   primaryPresent: boolean, primarySpritePresent: boolean, effectsPresent: boolean,
 *   groupsPresent: boolean, primarySpriteRenderable: boolean|null,
 *   effectsRenderable: boolean|null, foundryArtRenderable: boolean|null,
 *   readErrors: string[]}}
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

  const primary = typeof canvas !== 'undefined' ? (canvas?.primary ?? null) : null;
  const effects = typeof canvas !== 'undefined' ? (canvas?.effects ?? null) : null;
  const primaryPresent = !!primary;
  const primarySpritePresent = !!primary?.sprite;
  const effectsPresent = !!effects;
  const groupsPresent = primaryPresent && primarySpritePresent && effectsPresent;

  let primarySpriteRenderable = null;
  try {
    if (primary?.sprite && typeof primary.sprite.renderable === 'boolean') {
      primarySpriteRenderable = primary.sprite.renderable;
    }
  } catch (err) {
    readErrors.push(`reading canvas.primary.sprite.renderable threw: ${err?.message ?? err}`);
  }

  let effectsRenderable = null;
  try {
    if (effects && typeof effects.renderable === 'boolean') effectsRenderable = effects.renderable;
  } catch (err) {
    readErrors.push(`reading canvas.effects.renderable threw: ${err?.message ?? err}`);
  }

  // Single combined signal, mirroring the pre-2026-08-13 `environmentRenderable`
  // shape for callers that just want "is Foundry's own art currently showing" —
  // true only when BOTH halves genuinely read true; any false or unread (null)
  // on either half means Foundry's art is at least partly suppressed.
  const foundryArtRenderable =
    primarySpriteRenderable === true && effectsRenderable === true
      ? true
      : primarySpriteRenderable === null && effectsRenderable === null
        ? null
        : false;

  return {
    contextAlpha,
    clearAlpha,
    primaryPresent,
    primarySpritePresent,
    effectsPresent,
    groupsPresent,
    primarySpriteRenderable,
    effectsRenderable,
    foundryArtRenderable,
    readErrors,
  };
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
    // 'no-render-targets' is the one benign case: it just means no scene is drawn yet.
    if (decision.code !== 'no-render-targets') {
      console.warn(
        `[MSA] interface seam: NOT suppressing Foundry's art (${decision.code}) — ${decision.reason} ` +
          'Foundry is rendering the scene normally; MSA is underneath and invisible.'
      );
    }
    return { applied: false, code: decision.code, reason: decision.reason, facts };
  }

  try {
    // Two levers, not one — see header §3 / "THE PRIMARY-CACHE-FREEZE FIX".
    // `canvas.primary` itself is deliberately left renderable:true so its
    // CachedContainer keeps refreshing `renderTexture` every frame; only the
    // bound sprite's on-screen blit is suppressed.
    canvas.primary.sprite.renderable = false;
    canvas.effects.renderable = false;
  } catch (err) {
    console.error('[MSA] interface seam: suppressing Foundry primary/effects failed:', err);
    return {
      applied: false,
      code: 'suppress-threw',
      reason: `Setting canvas.primary.sprite.renderable/canvas.effects.renderable = false threw: ${err?.message ?? err}`,
      facts,
    };
  }
  return { applied: true, code: decision.code, reason: decision.reason, facts };
}

/**
 * Hand Foundry's art back. The reverse of applyArtSuppression, for the safety
 * slide's "fall back to Foundry" path and for Stop/Clear. Best-effort: restores
 * whichever of `canvas.primary.sprite` / `canvas.effects` actually exists,
 * rather than requiring both (the safety slide prefers showing SOME Foundry
 * art over refusing entirely on a partial state).
 *
 * @returns {boolean} whether at least one restore actually happened
 */
export function restoreFoundryArt() {
  try {
    const primary = typeof canvas !== 'undefined' ? (canvas?.primary ?? null) : null;
    const effects = typeof canvas !== 'undefined' ? (canvas?.effects ?? null) : null;
    let restored = false;
    if (primary?.sprite) {
      primary.sprite.renderable = true;
      restored = true;
    }
    if (effects) {
      effects.renderable = true;
      restored = true;
    }
    return restored;
  } catch (err) {
    console.error('[MSA] interface seam: restoring canvas.primary/canvas.effects failed:', err);
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
    primaryPresent: facts.primaryPresent,
    primarySpritePresent: facts.primarySpritePresent,
    effectsPresent: facts.effectsPresent,
    primarySpriteRenderable: facts.primarySpriteRenderable,
    effectsRenderable: facts.effectsRenderable,
    foundryArtRenderable: facts.foundryArtRenderable,
    readErrors: facts.readErrors,
    decision,
    msaOwnedGroups: [...MSA_OWNED_GROUPS],
    interpretation:
      'HEALTHY = contextAlpha:true, clearAlpha:0, foundryArtRenderable:false (i.e. ' +
      'primarySpriteRenderable:false AND effectsRenderable:false). That means the PIXI canvas is ' +
      "genuinely transparent, Foundry's art output is off (though canvas.primary's own internal cache " +
      "keeps refreshing every frame — deliberate, see the header's PRIMARY-CACHE-FREEZE FIX section — " +
      "so Foundry's own fog shader still reads a live snapshot), and its interface chrome (selection " +
      'borders, grid, walls, control icons, rulers) is drawing on top of MSA. ' +
      'contextAlpha:false is UNRECOVERABLE this session — the canvasConfig hook did not run in time. ' +
      'clearAlpha:1 with contextAlpha:true means Foundry re-clobbered the alpha and the ' +
      'initializeCanvasEnvironment re-assert is not firing. ' +
      'foundryArtRenderable:true alongside a refusal is CORRECT and deliberate — the safety slide ' +
      'chose Foundry rendering over a blank screen; read decision.reason for which fact forced it.',
  };
}

/**
 * ⚖️ THE SECOND-RENDERER CENSUS (TEMPORARY — `docs/holy/V4-Reckoning.md`; remove
 * with the Reckoning Report when its R4 gates close).
 *
 * HOW MUCH work Foundry's own renderer is still doing, as opposed to the seam
 * report above which answers WHETHER its art is showing. Those are different
 * questions and only the first one has ever been asked here.
 *
 * The PRIMARY-CACHE-FREEZE FIX in this file's header (2026-08-13, Bug #18)
 * deliberately leaves `canvas.primary.renderable === true` so `CachedContainer#
 * render()` keeps re-rendering every map object into `canvas.primary.
 * renderTexture` each frame — at CANVAS RESOLUTION — purely so Foundry's own fog
 * shader reads a live snapshot. That section states the cost honestly and ends
 * "Measure before assuming it matters." This function is the measurement's raw
 * material, and it is the one large GPU consumer MSA's own per-pass timestamps
 * structurally cannot see: different context, different ticker.
 *
 * Every read is defensive — this runs against live Foundry, and a diagnostic
 * that throws is worse than one that reports `null`.
 *
 * @returns {object} counts + sizes; `null` fields where Foundry did not answer.
 */
export function getFoundryRendererCensus() {
  const readErrors = [];
  const read = (label, fn) => {
    try {
      return fn();
    } catch (err) {
      readErrors.push(`${label}: ${err?.message ?? err}`);
      return null;
    }
  };
  const c = typeof canvas !== 'undefined' ? canvas : null;
  const primary = read('canvas.primary', () => c?.primary ?? null);
  const rt = read('canvas.primary.renderTexture', () => primary?.renderTexture ?? null);
  const kids = read('canvas.primary.children', () => (Array.isArray(primary?.children) ? primary.children : [])) ?? [];

  let renderableChildren = null;
  if (kids.length > 0 || Array.isArray(kids)) {
    renderableChildren = read('children renderable scan', () => {
      let n = 0;
      for (const child of kids) if (child?.renderable !== false && child?.visible !== false) n++;
      return n;
    });
  }

  const rtW = read('renderTexture.width', () => rt?.width ?? null);
  const rtH = read('renderTexture.height', () => rt?.height ?? null);

  return {
    // TRUE = Foundry re-renders its whole primary group into the cache every
    // frame. Deliberate (Bug #18) — and the thing to measure.
    primaryRenderable: read('primary.renderable', () => primary?.renderable ?? null),
    primaryCacheTexture: rtW && rtH ? { w: rtW, h: rtH, mpx: Math.round(((rtW * rtH) / 1e6) * 100) / 100 } : null,
    primaryChildren: kids.length,
    primaryChildrenRenderable: renderableChildren,
    tickerStarted: read('app.ticker.started', () => c?.app?.ticker?.started ?? null),
    tickerFps: read('app.ticker.FPS', () => (c?.app?.ticker?.FPS != null ? Math.round(c.app.ticker.FPS) : null)),
    visibilityVisible: read('visibility.visible', () => c?.visibility?.visible ?? null),
    rendererSize: read('app.renderer size', () =>
      c?.app?.renderer?.width != null ? { w: c.app.renderer.width, h: c.app.renderer.height } : null
    ),
    readErrors,
    interpretation:
      'primaryRenderable:true means Foundry is re-rendering primaryChildrenRenderable objects into a ' +
      'primaryCacheTexture-sized render texture EVERY FRAME, in its own GL context — invisible to every MSA ' +
      'perf zone, immune to every MSA effect toggle, and scaling with both resolution and floor (an upper ' +
      "floor makes more of Foundry's own objects renderable). Reversible console A/B: " +
      "`canvas.primary.renderable = false` suppresses it (Foundry's fog shader goes stale meanwhile — " +
      'that is Bug #18 returning by choice, restored with `= true`).',
  };
}
